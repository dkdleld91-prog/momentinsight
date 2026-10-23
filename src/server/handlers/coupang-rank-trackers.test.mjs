import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { handleCoupangRankTrackersRequest } from "./coupang-rank-trackers.mjs";
import {
  COLLECTOR_TOKEN_PATTERN,
  MANUAL_CLAIM_TOKEN_HEADER,
  MANUAL_EXTENSION_ID,
  MANUAL_EXTENSION_ZIP_PATH,
  MANUAL_TOKEN_PATTERN,
} from "../coupang-rank/contract.mjs";
import { inList } from "../coupang-rank/db.mjs";
import { executeRequest } from "../runtime.mjs";

const PRIMARY = "mml93-a01";
const NOW = "2026-10-17T03:00:00.000Z"; // KST 12:00(수집 시간대 안)
const CLIENT_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const CLIENT_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const CLIENT_GONE = "cccccccc-0000-4000-8000-00000000000c";
const HANDLER_SOURCE = readFileSync(new URL("./coupang-rank-trackers.mjs", import.meta.url), "utf8");

function uuid(n) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

// ── in 목록을 실제 전송 모양 그대로 흉내 낸다(2026-10-16 통합 검수: 큰따옴표 키워드가 목록 조회를 깨뜨림).
//    C 테스트는 @supabase/postgrest-js 를 import 하지 못하므로(연결 검사 §2.1) 두 쪽을 그대로 옮겨 적었다.
//    - postgrestJsInValue: postgrest-js 2.108.2 dist/index.mjs in() — , ( ) 가 있을 때만 "…" 로 감싸고 안의 " \ 는 그대로 둔다.
//    - parsePostgrestInList: PostgREST QueryParams.hs pListVal — lexeme '(' · pListElement sepBy1 ',' · lexeme ')'.
//      pListElement = try (pQuotedValue <* notFollowedBy (noneOf ",)")) <|> many (noneOf ",)"), 따옴표 안의 \x 는 x.
//      parseFlt 는 eof 를 요구하지 않아 ')' 뒤 꼬리는 오류 없이 버려진다.
function postgrestJsInValue(values) {
  return `(${Array.from(new Set(values)).map((value) => (typeof value === "string" && /[,()]/.test(value) ? `"${value}"` : `${value}`)).join(",")})`;
}

function parsePostgrestInList(text) {
  const source = String(text);
  let index = 0;
  const spaces = () => { while (source[index] === " " || source[index] === "\t") index += 1; };
  const quoted = () => {
    if (source[index] !== '"') return null;
    let cursor = index + 1;
    let value = "";
    while (cursor < source.length) {
      const char = source[cursor];
      if (char === "\\") {
        if (cursor + 1 >= source.length) return null;
        value += source[cursor + 1];
        cursor += 2;
        continue;
      }
      if (char === '"') {
        const next = source[cursor + 1];
        return next === undefined || next === "," || next === ")" ? { value, end: cursor + 1 } : null;
      }
      value += char;
      cursor += 1;
    }
    return null;
  };
  const element = () => {
    const hit = quoted();
    if (hit) {
      index = hit.end;
      return hit.value;
    }
    const start = index;
    while (index < source.length && source[index] !== "," && source[index] !== ")") index += 1;
    return source.slice(start, index);
  };
  spaces();
  if (source[index] !== "(") return { error: "expected (" };
  index += 1;
  spaces();
  const values = [element()];
  while (source[index] === ",") {
    index += 1;
    values.push(element());
  }
  spaces();
  if (source[index] !== ")") return { error: `unexpected ${JSON.stringify(source[index] ?? "end")}` };
  return { values };
}

// ── MockQuery: N30 naver-rank-trackers.test.mjs 의 MockQuery 를 복사해 C 에 필요한 것(is·range·delete·upsert·count·
//    rpc 기록·오류 주입·쿼리 기록)을 더했다. N30 테스트 파일은 고치지 않는다.
class MockQuery {
  constructor(state, table) {
    this.state = state;
    this.table = table;
    this.operation = "select";
    this.values = null;
    this.options = {};
    this.filters = [];
    this.log = [];
    this.orders = [];
    this.rowLimit = Infinity;
    this.rangeStart = 0;
    this.rangeEnd = Infinity;
    this.head = false;
    this.countExact = false;
    this.returning = false;
  }

  update(values) {
    this.operation = "update";
    this.values = values;
    return this;
  }

  insert(values) {
    this.operation = "insert";
    this.values = values;
    return this;
  }

  upsert(values, options = {}) {
    this.operation = "upsert";
    this.values = values;
    this.options = options;
    return this;
  }

  delete() {
    this.operation = "delete";
    return this;
  }

  addFilter(op, column, value, predicate) {
    this.log.push({ op, column, value });
    this.filters.push(predicate);
    return this;
  }

  eq(column, value) {
    return this.addFilter("eq", column, value, (row) => row[column] === value);
  }

  gte(column, value) {
    return this.addFilter("gte", column, value, (row) => row[column] !== null && row[column] !== undefined && row[column] >= value);
  }

  gt(column, value) {
    return this.addFilter("gt", column, value, (row) => row[column] !== null && row[column] !== undefined && row[column] > value);
  }

  lte(column, value) {
    return this.addFilter("lte", column, value, (row) => row[column] !== null && row[column] !== undefined && row[column] <= value);
  }

  // in·filter(col, "in", …) 둘 다 실제 전송 문자열을 PostgREST 문법으로 다시 읽은 값으로 거른다(위 설명).
  wireIn(column, wire) {
    const parsed = parsePostgrestInList(wire);
    if (parsed.error) {
      this.wireError = { code: "PGRST100", message: `failed to parse filter (${parsed.error})` };
      return this.addFilter("in", column, [], () => false);
    }
    const allowed = new Set(parsed.values);
    this.log.push({ op: "in", column, value: parsed.values, wire });
    this.filters.push((row) => row[column] !== null && row[column] !== undefined && allowed.has(String(row[column])));
    return this;
  }

  in(column, values) {
    return this.wireIn(column, postgrestJsInValue(values));
  }

  filter(column, operator, value) {
    if (operator !== "in") throw new Error(`MockQuery.filter: ${operator} 는 흉내 내지 않음`);
    return this.wireIn(column, String(value));
  }

  is(column, value) {
    return this.addFilter("is", column, value, (row) => (value === null ? row[column] === null || row[column] === undefined : row[column] === value));
  }

  order(column, options = {}) {
    this.orders.push({ column, ascending: options.ascending !== false });
    return this;
  }

  limit(value) {
    this.rowLimit = Math.max(0, Number(value || 0));
    return this;
  }

  range(from, to) {
    this.rangeStart = from;
    this.rangeEnd = to;
    return this;
  }

  select(_columns, options = {}) {
    if (this.operation === "select") {
      this.head = options.head === true;
      this.countExact = options.count === "exact";
    } else {
      this.returning = true;
    }
    return this;
  }

  single() {
    return this.execute("single");
  }

  maybeSingle() {
    return this.execute("maybe");
  }

  then(resolve, reject) {
    return this.execute("many").then(resolve, reject);
  }

  shape(rows, mode, count = null) {
    const copies = rows.map((row) => ({ ...row }));
    if (mode === "single") {
      return copies.length === 1 ? { data: copies[0], error: null } : { data: null, error: { code: "PGRST116", message: "rows" } };
    }
    if (mode === "maybe") {
      if (copies.length > 1) return { data: null, error: { code: "PGRST116", message: "rows" } };
      return { data: copies[0] ?? null, error: null };
    }
    return { data: copies, error: null, count };
  }

  async execute(mode) {
    const state = this.state;
    state.queries.push({ table: this.table, operation: this.operation, filters: this.log, values: this.values, options: this.options });
    if (this.wireError) return { data: null, error: this.wireError, count: null };
    const injected = state.errors.find((entry) => entry.table === this.table
      && (!entry.operation || entry.operation === this.operation)
      && (!entry.when || entry.when(this)));
    if (injected) {
      if (injected.once) state.errors.splice(state.errors.indexOf(injected), 1);
      return { data: null, error: injected.error, count: null };
    }
    const rows = state.tables[this.table];
    if (!rows) return { data: null, error: { code: "42P01", message: `relation "${this.table}" does not exist` }, count: null };
    const matches = (row) => this.filters.every((filter) => filter(row));

    if (this.operation === "insert") {
      const values = Array.isArray(this.values) ? this.values : [this.values];
      const inserted = [];
      for (const value of values) {
        const row = defaultsFor(this.table, value);
        const error = state.guard?.(this.table, "insert", row, null, state) || uniqueViolation(this.table, rows, row);
        if (error) return { data: null, error };
        inserted.push(row);
      }
      rows.push(...inserted);
      return this.returning ? this.shape(inserted, mode) : { data: null, error: null };
    }

    if (this.operation === "upsert") {
      const key = this.options.onConflict;
      const values = Array.isArray(this.values) ? this.values : [this.values];
      const touched = [];
      for (const value of values) {
        const existing = rows.find((row) => row[key] === value[key]);
        if (existing) {
          Object.assign(existing, value);
          touched.push(existing);
        } else {
          const row = { updated_at: state.now, ...value };
          rows.push(row);
          touched.push(row);
        }
      }
      return this.returning ? this.shape(touched, mode) : { data: null, error: null };
    }

    let selected = rows.filter(matches);
    for (const { column, ascending } of [...this.orders].reverse()) {
      selected = [...selected].sort((left, right) => {
        const a = left[column];
        const b = right[column];
        if (a === b) return 0;
        if (a === null || a === undefined) return ascending ? 1 : -1;
        if (b === null || b === undefined) return ascending ? -1 : 1;
        const comparison = a > b ? 1 : -1;
        return ascending ? comparison : -comparison;
      });
    }
    const count = selected.length;

    if (this.operation === "update") {
      for (const row of selected) {
        const error = state.guard?.(this.table, "update", { ...row, ...this.values }, row, state);
        if (error) return { data: null, error };
      }
      selected.forEach((row) => Object.assign(row, this.values));
      return this.returning ? this.shape(selected, mode) : { data: null, error: null };
    }

    if (this.operation === "delete") {
      const removed = new Set(selected);
      state.tables[this.table] = rows.filter((row) => !removed.has(row));
      if (this.table === "coupang_rank_trackers") {
        // FK cascade
        state.tables.coupang_rank_days = state.tables.coupang_rank_days.filter((day) => !selected.some((row) => row.id === day.tracker_id));
      }
      return this.returning ? this.shape(selected, mode) : { data: null, error: null };
    }

    selected = selected.slice(this.rangeStart, Number.isFinite(this.rangeEnd) ? this.rangeEnd + 1 : undefined).slice(0, this.rowLimit);
    if (this.head) return { data: null, error: null, count };
    return this.shape(selected, mode, this.countExact ? count : null);
  }
}

function defaultsFor(table, value) {
  if (table === "coupang_rank_trackers") {
    return {
      id: randomUUID(),
      product_title: null,
      status: "active",
      paused_at: null,
      created_kst_day: "2026-10-17",
      current_result: null,
      current_rank: null,
      current_organic_count: null,
      current_ad_order: null,
      current_same_option: null,
      last_checked_at: null,
      last_found_at: null,
      created_at: NOW,
      ...value,
    };
  }
  if (table === "coupang_rank_collectors") {
    return { id: randomUUID(), created_at: NOW, revoked_at: null, last_seen_at: null, ...value };
  }
  return { id: randomUUID(), ...value };
}

function uniqueViolation(table, rows, row) {
  if (table === "coupang_rank_trackers" && rows.some((item) => item.agency_code === row.agency_code
    && item.keyword_key === row.keyword_key && item.product_id === row.product_id)) {
    return { code: "23505", message: "duplicate key value violates unique constraint" };
  }
  if (table === "coupang_rank_collectors" && rows.some((item) => item.token_sha256 === row.token_sha256)) {
    return { code: "23505", message: "duplicate" };
  }
  return null;
}

function settingsRow(overrides = {}) {
  return {
    id: 1,
    enabled: false,
    team_access_enabled: true,
    client_view_enabled: true,
    checks_per_day: 2,
    min_gap_seconds: 240,
    gap_jitter_seconds: 120,
    max_runs_per_hour: 12,
    max_runs_per_day: 120,
    active_from_hour: 8,
    active_to_hour: 23,
    default_account_limit: 20,
    global_keyword_limit: 150,
    window_mode: "offscreen",
    min_collector_version: null,
    max_storage_mb: 60,
    db_size_stop_mb: 450,
    cooldown_until: null,
    cooldown_reason: null,
    needs_owner_review: false,
    review_reason: null,
    budget_blocked: false,
    budget_reason: null,
    error_streak: 0,
    empty_streak: 0,
    rate_changed_at: "2026-10-14T00:00:00.000Z",
    updated_at: "2026-10-14T00:00:00.000Z",
    updated_by: null,
    ...overrides,
  };
}

function trackerRow(overrides = {}) {
  return defaultsFor("coupang_rank_trackers", {
    agency_code: PRIMARY,
    client_id: null,
    keyword: "아이폰 18프로 사생활 보호 필름",
    keyword_key: "아이폰 18프로 사생활 보호 필름",
    product_id: "8533720933",
    product_url: "https://www.coupang.com/vp/products/8533720933",
    vendor_item_id: "96009802650",
    group_name: "기본 그룹",
    sort_order: 100,
    created_by: "owner",
    created_kst_day: "2026-10-16",
    created_at: "2026-10-16T03:00:00.000Z",
    ...overrides,
  });
}

function createState(overrides = {}) {
  const state = {
    now: NOW,
    queries: [],
    rpcCalls: [],
    errors: [],
    guard: null,
    firstCheck: "queued",
    stats: { blocked48h: 0, empty48h: 0, success48h: 60, activeKeywords: 41, ineligibleActiveTrackers: 0 },
    tables: {
      coupang_rank_settings: [settingsRow(overrides.settings)],
      coupang_rank_account_limits: [{ agency_code: PRIMARY, keyword_limit: 100, updated_at: NOW }],
      coupang_rank_collectors: [],
      coupang_rank_trackers: [],
      coupang_rank_keywords: [],
      coupang_rank_runs: [],
      coupang_rank_snapshots: [],
      coupang_rank_days: [],
      coupang_rank_cooldowns: [],
      clients: [
        { id: CLIENT_A, agency_code: "adv-a", status: "active", disconnected_at: null, name: "광고주 A" },
        { id: CLIENT_B, agency_code: "adv-b", status: "active", disconnected_at: null, name: "광고주 B" },
        { id: CLIENT_GONE, agency_code: "adv-gone", status: "active", disconnected_at: "2026-10-10T00:00:00Z", name: "해제된 광고주" },
      ],
      operation_team_codes: [
        { id: uuid(9001), team_code: "Team-X1", owner_agency_code: PRIMARY, status: "revoked", team_name: "팀 X" },
        { id: uuid(9002), team_code: "team-y2", owner_agency_code: "someone-else", status: "active", team_name: "남의 팀" },
      ],
    },
    rpc: {
      coupang_rank_limit_status: ({ p_agency_code: agencyCode, p_keyword_key: keywordKey }, current) => {
        const active = current.tables.coupang_rank_trackers.filter((row) => row.status === "active");
        const settings = current.tables.coupang_rank_settings[0];
        const limitRow = current.tables.coupang_rank_account_limits.find((row) => row.agency_code === agencyCode);
        return {
          data: {
            limit: limitRow ? limitRow.keyword_limit : settings.default_account_limit,
            used: active.filter((row) => row.agency_code === agencyCode).length,
            globalLimit: settings.global_keyword_limit,
            globalUsed: new Set(active.map((row) => row.keyword_key)).size,
            keywordActive: keywordKey !== null && active.some((row) => row.keyword_key === keywordKey),
          },
          error: null,
        };
      },
      coupang_rank_after_activate: ({ p_tracker_id: trackerId }, current) => {
        const tracker = current.tables.coupang_rank_trackers.find((row) => row.id === trackerId);
        if (tracker && !current.tables.coupang_rank_keywords.some((row) => row.keyword_key === tracker.keyword_key)) {
          current.tables.coupang_rank_keywords.push({
            keyword_key: tracker.keyword_key, next_due_at: "2026-10-17T03:05:00.000Z", slot_ends_at: "2026-10-17T06:30:00.000Z",
            lease_run_id: null, consecutive_failures: 0, consecutive_unsupported: 0, last_status: null,
          });
        }
        return { data: { firstCheck: current.firstCheck, nextDueAt: "2026-10-17T03:05:00.000Z" }, error: null };
      },
      coupang_rank_stats: (_args, current) => ({ data: { ...current.stats }, error: null }),
      coupang_rank_replan_all: () => ({ data: 7, error: null }),
    },
  };
  return state;
}

function makeCtx(state) {
  return {
    supabaseAdmin: {
      from(table) {
        return new MockQuery(state, table);
      },
      async rpc(name, args) {
        state.rpcCalls.push({ name, args });
        const fn = state.rpc[name];
        if (!fn) return { data: null, error: { code: "PGRST202", message: "function not found" } };
        return fn(args, state);
      },
    },
  };
}

function ownerHeaders(target) {
  const headers = {
    "x-mi-session-role": "owner",
    "x-mi-session-scope": "account-only",
    "x-mi-owner-agency-code": PRIMARY,
  };
  if (target !== undefined) headers["x-mi-agency-code"] = target;
  return headers;
}

function teamHeaders(code, { accountOnly = false, teamCode = "team-a", accessCode = code } = {}) {
  return {
    "x-mi-session-role": "team",
    "x-mi-session-scope": accountOnly ? "account-only" : "advertiser",
    "x-mi-team-code": teamCode,
    "x-mi-agency-code": code,
    "x-mi-rank-access-code": accessCode,
  };
}

function clientHeaders(code, accessCode = code) {
  return {
    "x-mi-session-role": "client",
    "x-mi-session-scope": "advertiser",
    "x-mi-agency-code": code,
    "x-mi-rank-access-code": accessCode,
  };
}

function makeRequest(method, { query = "", headers = {}, body, rawBody, contentType } = {}) {
  const init = { method, headers: new Headers(headers) };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers.set("content-type", contentType || "application/json");
  } else if (rawBody !== undefined) {
    init.body = rawBody;
    if (contentType) init.headers.set("content-type", contentType);
  }
  return new Request(`https://insight.momentlabs.co.kr/api/coupang-rank-trackers${query}`, init);
}

async function call(state, method, options = {}) {
  const response = await handleCoupangRankTrackersRequest(makeRequest(method, options), makeCtx(state), { now: NOW });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
}

const list = (state, headers, query = "?limit=500") => call(state, "GET", { query, headers });
const post = (state, headers, body) => call(state, "POST", { headers, body });

function trackerQueries(state) {
  return state.queries.filter((query) => query.table === "coupang_rank_trackers");
}

function assertAgencyScoped(state, agencyCode) {
  const queries = trackerQueries(state);
  assert.ok(queries.length > 0, "추적기 쿼리가 있어야 함");
  for (const query of queries) {
    if (query.operation === "insert") {
      assert.equal(query.values.agency_code, agencyCode);
      continue;
    }
    assert.ok(
      query.filters.some((filter) => filter.op === "eq" && filter.column === "agency_code" && filter.value === agencyCode),
      `${query.operation} 쿼리에 agency_code = ${agencyCode} 조건이 없음: ${JSON.stringify(query.filters)}`,
    );
  }
}

// ── §5.2 역할표 ─────────────────────────────────────────────────────────────

test("역할 1·2: 세션 머리글 없음 → 401, 체험 → 403 TRIAL_LOCKED(GET·POST)", async () => {
  const state = createState();
  const none = await list(state, {});
  assert.equal(none.status, 401);
  assert.equal(none.body.code, "COUPANG_SESSION_REQUIRED");
  assert.equal(none.body.ok, false);
  const trialHeaders = { "x-mi-session-role": "client", "x-mi-session-scope": "trial", "x-mi-agency-code": "trial-abcd1234" };
  const trialGet = await list(state, trialHeaders);
  assert.equal(trialGet.status, 403);
  assert.equal(trialGet.body.code, "TRIAL_LOCKED");
  const trialPost = await post(state, trialHeaders, { action: "pause", ids: [uuid(1)] });
  assert.equal(trialPost.status, 403);
  assert.equal(trialPost.body.code, "TRIAL_LOCKED");
  const trialAccess = await list(state, trialHeaders, "?view=access");
  assert.equal(trialAccess.status, 403);
});

test("역할 3 ①: 총관리자 대표 코드(빈값·owner-session·session 자리표시자 포함)", async () => {
  for (const target of [undefined, "", "owner-session", "session", PRIMARY, "MML93-A01"]) {
    const state = createState();
    state.tables.coupang_rank_trackers.push(trackerRow());
    const { status, body } = await list(state, ownerHeaders(target));
    assert.equal(status, 200, String(target));
    assert.equal(body.scopeAgencyCode, PRIMARY);
    assert.equal(body.scopeMode, "owner");
    assert.equal(body.scopeClientId, "");
    assert.equal(body.scopeKey, `owner:${PRIMARY}`);
    assert.equal(body.readOnly, false);
    assert.equal(body.trackers.length, 1);
  }
});

test("역할 3: 레거시 코드는 대표 코드로 바뀐다(MI_LEGACY_AGENCY_CODES)", async () => {
  const previous = process.env.MI_LEGACY_AGENCY_CODES;
  process.env.MI_LEGACY_AGENCY_CODES = "old-owner, Older-Owner";
  try {
    const state = createState();
    const { body } = await list(state, ownerHeaders("older-owner"));
    assert.equal(body.scopeAgencyCode, PRIMARY);
  } finally {
    if (previous === undefined) delete process.env.MI_LEGACY_AGENCY_CODES;
    else process.env.MI_LEGACY_AGENCY_CODES = previous;
  }
});

test("역할 3 ②: 활성 광고주는 clientId 와 함께 열리고, 연결 해제 광고주는 열리지 않는다", async () => {
  const state = createState();
  state.tables.coupang_rank_trackers.push(trackerRow({ agency_code: "adv-a", client_id: CLIENT_A }));
  state.tables.coupang_rank_trackers.push(trackerRow({ agency_code: "adv-b", client_id: CLIENT_B, product_id: "1111" }));
  const { status, body } = await list(state, ownerHeaders("ADV-A"));
  assert.equal(status, 200);
  assert.equal(body.scopeAgencyCode, "adv-a");
  assert.equal(body.scopeClientId, CLIENT_A);
  assert.equal(body.scopeMode, "owner");
  assert.equal(body.trackers.length, 1);
  assert.equal(body.trackers[0].productId, "8533720933");
  const gone = await list(createState(), ownerHeaders("adv-gone"));
  assert.equal(gone.status, 403);
  assert.equal(gone.body.code, "COUPANG_SCOPE_NOT_FOUND");
});

test("역할 3 ③: 대표 소유 팀 코드(대소문자·상태 무관)는 조회·중지·그룹·삭제만, 등록·재개는 SCOPE_NO_CREATE", async () => {
  const state = createState();
  const paused = trackerRow({ agency_code: "team-x1", status: "paused", paused_at: "2026-10-16T00:00:00Z", product_id: "2222" });
  const active = trackerRow({ agency_code: "team-x1", product_id: "3333" });
  const removable = trackerRow({ agency_code: "team-x1", product_id: "4444" });
  state.tables.coupang_rank_trackers.push(paused, active, removable);
  const headers = ownerHeaders("team-x1");
  const view = await list(state, headers);
  assert.equal(view.status, 200);
  assert.equal(view.body.scopeAgencyCode, "team-x1");
  assert.equal(view.body.scopeMode, "owner");
  assert.equal(view.body.trackers.length, 3);

  const create = await post(state, headers, { action: "create", keyword: "필름", productUrl: "8533720933" });
  assert.equal(create.status, 403);
  assert.equal(create.body.code, "COUPANG_SCOPE_NO_CREATE");
  const resume = await post(state, headers, { action: "resume", ids: [paused.id] });
  assert.equal(resume.status, 403);
  assert.equal(resume.body.code, "COUPANG_SCOPE_NO_CREATE");
  assert.equal(state.tables.coupang_rank_trackers.find((row) => row.id === paused.id).status, "paused");

  const pause = await post(state, headers, { action: "pause", ids: [active.id] });
  assert.deepEqual(pause.body, { ok: true, updated: 1 });
  const group = await post(state, headers, { action: "group", ids: [active.id], groupName: "옛 팀" });
  assert.deepEqual(group.body, { ok: true, updated: 1 });
  const removed = await post(state, headers, { action: "delete", ids: [removable.id] });
  assert.deepEqual(removed.body, { ok: true, deleted: 1 });
  assert.equal(state.tables.coupang_rank_trackers.length, 2);

  // 다른 사람이 소유한 팀 코드는 ③이 아니다
  const foreign = await list(createState(), ownerHeaders("team-y2"));
  assert.equal(foreign.body.code, "COUPANG_SCOPE_NOT_FOUND");
});

test("역할 3 ④·대표 코드 불일치: SCOPE_NOT_FOUND / ACCESS_DENIED", async () => {
  const state = createState();
  const unknown = await list(state, ownerHeaders("nobody"));
  assert.equal(unknown.status, 403);
  assert.equal(unknown.body.code, "COUPANG_SCOPE_NOT_FOUND");
  const forged = await list(state, { ...ownerHeaders(), "x-mi-owner-agency-code": "someone-else" });
  assert.equal(forged.status, 403);
  assert.equal(forged.body.code, "COUPANG_ACCESS_DENIED");
  const missing = await list(state, { "x-mi-session-role": "owner", "x-mi-session-scope": "account-only" });
  assert.equal(missing.body.code, "COUPANG_ACCESS_DENIED");
});

test("역할 4: 운영팀 — 공개 꺼짐·코드 불일치·계정 전용·광고주 범위", async () => {
  const closed = createState({ settings: { team_access_enabled: false } });
  const off = await list(closed, teamHeaders("adv-a"));
  assert.equal(off.status, 403);
  assert.equal(off.body.code, "COUPANG_TEAM_NOT_OPEN");

  const state = createState();
  state.tables.coupang_rank_trackers.push(trackerRow({ agency_code: "adv-a", client_id: CLIENT_A }));
  state.tables.coupang_rank_trackers.push(trackerRow({ agency_code: "team-a", product_id: "5555" }));
  const mismatch = await list(state, teamHeaders("adv-a", { accessCode: "adv-b" }));
  assert.equal(mismatch.status, 403);
  assert.equal(mismatch.body.code, "COUPANG_ACCESS_DENIED");

  const advertiser = await list(state, teamHeaders("adv-a"));
  assert.equal(advertiser.status, 200);
  assert.equal(advertiser.body.scopeMode, "advertiser");
  assert.equal(advertiser.body.scopeClientId, CLIENT_A);
  assert.equal(advertiser.body.trackers.length, 1);
  assert.ok(advertiser.body.limit, "운영팀은 한도를 받는다");

  const accountOnly = await list(state, teamHeaders("team-a", { accountOnly: true, teamCode: "TEAM-A" }));
  assert.equal(accountOnly.status, 200);
  assert.equal(accountOnly.body.scopeMode, "team-account");
  assert.equal(accountOnly.body.scopeClientId, "");
  assert.equal(accountOnly.body.trackers[0].productId, "5555");

  const wrongTeam = await list(state, teamHeaders("team-a", { accountOnly: true, teamCode: "team-b" }));
  assert.equal(wrongTeam.body.code, "COUPANG_ACCESS_DENIED");

  const noClient = await list(state, teamHeaders("adv-gone"));
  assert.equal(noClient.status, 403);
  assert.equal(noClient.body.code, "COUPANG_SCOPE_NOT_FOUND");
});

test("역할 5: 광고주 — 공개 꺼짐·쓰기 금지·읽기 전용 조회(한도 null)", async () => {
  const closed = createState({ settings: { client_view_enabled: false } });
  assert.equal((await list(closed, clientHeaders("adv-a"))).body.code, "COUPANG_CLIENT_NOT_OPEN");
  assert.equal((await post(closed, clientHeaders("adv-a"), { action: "pause", ids: [uuid(1)] })).body.code, "COUPANG_CLIENT_NOT_OPEN");

  const state = createState();
  state.tables.coupang_rank_trackers.push(trackerRow({ agency_code: "adv-a", client_id: CLIENT_A }));
  for (const action of ["create", "pause", "resume", "delete", "group", "settings-update", "collector-enable", "collector-token-create"]) {
    const result = await post(state, clientHeaders("adv-a"), { action, ids: [uuid(1)] });
    assert.equal(result.status, 403, action);
    assert.equal(result.body.code, "COUPANG_READ_ONLY", action);
  }
  const view = await list(state, clientHeaders("adv-a"));
  assert.equal(view.status, 200);
  assert.equal(view.body.readOnly, true);
  assert.equal(view.body.scopeMode, "advertiser");
  assert.equal(view.body.scopeClientId, CLIENT_A);
  assert.equal(view.body.limit, null);
  assert.equal(state.rpcCalls.filter((entry) => entry.name === "coupang_rank_limit_status").length, 0);
  assert.equal((await list(state, clientHeaders("adv-a", "adv-b"))).body.code, "COUPANG_ACCESS_DENIED");
  assert.equal((await list(state, clientHeaders("adv-gone"))).body.code, "COUPANG_SCOPE_NOT_FOUND");
});

test("운영팀·광고주는 대표 코드 범위로 열리지 않는다(레거시 코드 매핑 포함)", async () => {
  const previous = process.env.MI_LEGACY_AGENCY_CODES;
  process.env.MI_LEGACY_AGENCY_CODES = "old-owner";
  try {
    const state = createState();
    state.tables.coupang_rank_trackers.push(trackerRow());
    for (const headers of [
      teamHeaders(PRIMARY),
      teamHeaders("old-owner", { accountOnly: true, teamCode: "old-owner" }),
      clientHeaders(PRIMARY),
      clientHeaders("old-owner"),
    ]) {
      const result = await list(state, headers);
      assert.equal(result.status, 403);
      assert.equal(result.body.code, "COUPANG_ACCESS_DENIED");
    }
  } finally {
    if (previous === undefined) delete process.env.MI_LEGACY_AGENCY_CODES;
    else process.env.MI_LEGACY_AGENCY_CODES = previous;
  }
});

test("역할 6: 그 밖의 역할은 ACCESS_DENIED", async () => {
  const state = createState();
  const result = await list(state, { "x-mi-session-role": "admin", "x-mi-session-scope": "advertiser", "x-mi-agency-code": PRIMARY });
  assert.equal(result.status, 403);
  assert.equal(result.body.code, "COUPANG_ACCESS_DENIED");
});

test("body·query 의 자격 값은 읽지 않는다", async () => {
  const state = createState();
  state.tables.coupang_rank_trackers.push(trackerRow({ agency_code: "adv-a", client_id: CLIENT_A }));
  // 총관리자가 query·body 로 다른 범위를 보내도 머리글 범위(대표 코드)만 쓴다
  const owner = await list(state, ownerHeaders(), "?limit=500&agencyCode=adv-a&agency_code=adv-a&accessCode=adv-a");
  assert.equal(owner.body.scopeAgencyCode, PRIMARY);
  assert.equal(owner.body.trackers.length, 0);
  // 머리글 없는 요청은 body 의 자격 값으로 열리지 않는다
  const forged = await post(state, {}, { action: "pause", ids: [uuid(1)], agencyCode: "adv-a", accessCode: "adv-a", role: "owner" });
  assert.equal(forged.status, 401);
  // 운영팀이 body 로 다른 광고주를 보내도 머리글 범위로만 바뀐다
  const target = state.tables.coupang_rank_trackers[0];
  const teamPause = await post(state, teamHeaders("adv-b"), { action: "pause", ids: [target.id], agencyCode: "adv-a", accessCode: "adv-a" });
  assert.deepEqual(teamPause.body, { ok: true, updated: 0 });
  assert.equal(target.status, "active");
});

test("추적기 쿼리는 모두 agency_code 조건을 건다(다른 계정 id 로는 0행)", async () => {
  const state = createState();
  const mine = trackerRow({ agency_code: "adv-a", client_id: CLIENT_A, product_id: "6001" });
  const theirs = trackerRow({ agency_code: "adv-b", client_id: CLIENT_B, product_id: "6002" });
  const theirsPaused = trackerRow({ agency_code: "adv-b", client_id: CLIENT_B, product_id: "6003", status: "paused", paused_at: NOW });
  state.tables.coupang_rank_trackers.push(mine, theirs, theirsPaused);
  const headers = teamHeaders("adv-a");
  assert.deepEqual((await post(state, headers, { action: "pause", ids: [theirs.id] })).body, { ok: true, updated: 0 });
  assert.deepEqual((await post(state, headers, { action: "group", ids: [theirs.id], groupName: "남의 것" })).body, { ok: true, updated: 0 });
  assert.deepEqual((await post(state, headers, { action: "resume", ids: [theirsPaused.id] })).body, { ok: true, updated: 0 });
  assert.deepEqual((await post(state, headers, { action: "delete", ids: [theirs.id] })).body, { ok: true, deleted: 0 });
  const runs = await list(state, headers, `?view=runs&trackerId=${theirs.id}`);
  assert.equal(runs.status, 404);
  assert.equal(runs.body.code, "COUPANG_TRACKER_NOT_FOUND");
  await list(state, headers);
  await post(state, headers, { action: "create", keyword: "새 키워드", productUrl: "https://www.coupang.com/vp/products/7001" });
  await post(state, headers, { action: "pause", ids: [mine.id] });
  await post(state, headers, { action: "resume", ids: [mine.id] });
  assert.equal(theirs.status, "active");
  assert.equal(theirs.group_name, "기본 그룹");
  assert.equal(theirsPaused.status, "paused");
  assert.equal(state.tables.coupang_rank_trackers.length, 4);
  assertAgencyScoped(state, "adv-a");
});

// ── 목록 ───────────────────────────────────────────────────────────────────

function keywordRow(key, overrides = {}) {
  return {
    keyword_key: key,
    next_due_at: "2026-10-17T07:41:00.000Z",
    slot_ends_at: "2026-10-17T14:00:00.000Z",
    lease_run_id: null,
    consecutive_failures: 0,
    consecutive_unsupported: 0,
    last_status: "ok",
    ...overrides,
  };
}

test("GET 목록: 응답 모양·필드 순서·days 키·days30·한도·수집기 띠", async () => {
  const state = createState({ settings: { enabled: true } });
  const tracker = trackerRow({
    current_result: "found", current_rank: 28, current_organic_count: 50, current_ad_order: 8, current_same_option: true,
    last_checked_at: "2026-10-17T02:11:05.000Z", last_found_at: "2026-10-17T02:11:05.000Z",
  });
  state.tables.coupang_rank_trackers.push(tracker);
  state.tables.coupang_rank_keywords.push(keywordRow(tracker.keyword_key));
  state.tables.coupang_rank_collectors.push({ id: uuid(500), revoked_at: null, last_seen_at: "2026-10-17T02:58:00.000Z", last_version: "1.0.0" });
  state.tables.coupang_rank_runs.push(
    { id: uuid(600), keyword_key: tracker.keyword_key, status: "ok", claimed_at: "2026-10-17T02:11:05.000Z" },
    { id: uuid(601), keyword_key: tracker.keyword_key, status: "timeout", claimed_at: "2026-10-17T02:20:00.000Z" },
  );
  state.tables.coupang_rank_days.push(
    { tracker_id: tracker.id, kst_day: "2026-10-17", slot_minute: 480, slot_index: 0, result: "found", rank: 28, organic_count: 50, ad_order: 8, checked_at: "2026-10-17T02:11:05.000Z", success_count: 1, failure_count: 0, best_rank: 28 },
    { tracker_id: tracker.id, kst_day: "2026-10-16", slot_minute: 930, slot_index: 1, result: "found", rank: 31, organic_count: 50, ad_order: null, checked_at: "2026-10-16T10:02:00.000Z", success_count: 2, failure_count: 1, best_rank: 25 },
    { tracker_id: tracker.id, kst_day: "2026-10-16", slot_minute: 480, slot_index: 0, result: "found", rank: 31, organic_count: 50, ad_order: null, checked_at: "2026-10-16T01:02:00.000Z", success_count: 1, failure_count: 0, best_rank: 25 },
    { tracker_id: tracker.id, kst_day: "2026-09-01", slot_minute: 480, slot_index: 0, result: "found", rank: 1, organic_count: 50, ad_order: null, checked_at: "2026-09-01T01:00:00.000Z", success_count: 1, failure_count: 0, best_rank: 1 },
  );
  const { status, body, headers } = await list(state, ownerHeaders());
  assert.equal(status, 200);
  assert.equal(headers.get("cache-control"), "no-store");
  assert.equal(headers.get("access-control-allow-methods"), "GET, POST, OPTIONS");
  assert.equal(headers.get("access-control-allow-headers"), "content-type, x-mi-csrf, x-mi-agency-code");
  assert.deepEqual(Object.keys(body), [
    "ok", "setupRequired", "scopeKey", "scopeAgencyCode", "scopeClientId", "scopeMode", "readOnly",
    "returnedCount", "totalCount", "hasMore", "complete", "todayKst", "days30", "limit", "collector", "trackers", "manual",
  ]);
  // ① 지금 확인 칸(총관리자만). 수동 칸이 없는 설정(대표 SQL 전)이면 요약 RPC 없이 setup_required.
  assert.deepEqual(body.manual, { state: "setup_required" });
  assert.equal(state.rpcCalls.some((entry) => entry.name === "coupang_rank_manual_summary"), false);
  assert.equal(body.setupRequired, false);
  assert.equal(body.todayKst, "2026-10-17");
  assert.equal(body.days30.length, 30);
  assert.equal(body.days30[0], "2026-10-17");
  assert.equal(body.days30[29], "2026-09-18");
  assert.deepEqual([body.returnedCount, body.totalCount, body.hasMore, body.complete], [1, 1, false, true]);
  assert.deepEqual(body.limit, { used: 1, max: 100, globalUsed: 1, globalMax: 150, capacity: 60 });
  assert.deepEqual(body.collector, {
    state: "ok", lastSuccessAt: "2026-10-17T02:11:05.000Z", checksPerDay: 2, activeFromHour: 8, activeToHour: 23, cooldownUntil: null,
  });
  const item = body.trackers[0];
  assert.deepEqual(Object.keys(item), [
    "id", "keyword", "keywordKey", "productId", "productUrl", "vendorItemId", "productTitle", "groupName", "sortOrder",
    "status", "createdAt", "createdDay", "pausedAt", "pausedDay",
    "current", "nextCheckAt", "nextCheckState", "keywordHealth", "summary", "days",
  ]);
  assert.deepEqual(item.current, { result: "found", rank: 28, organicCount: 50, adOrder: 8, sameOption: true, checkedAt: "2026-10-17T02:11:05.000Z" });
  assert.equal(item.nextCheckState, "scheduled");
  assert.equal(item.nextCheckAt, "2026-10-17T07:41:00.000Z");
  assert.deepEqual(item.keywordHealth, { consecutiveFailures: 0, consecutiveUnsupported: 0, lastStatus: "ok" });
  assert.deepEqual(item.days, [
    { d: "2026-10-17", s: "found", r: 28, n: 50, a: 8, t: "11:11", c: 1, f: 0, b: 28, k: 0 },
    { d: "2026-10-16", s: "found", r: 31, n: 50, a: null, t: "19:02", c: 3, f: 1, b: 25, k: 1 },
  ]);
  assert.equal(item.summary.best30, 25);
  assert.equal(item.summary.avg7, 29.5);
  assert.equal(item.summary.trend, "up");
  assert.equal(item.summary.trendDelta, 3);
  assert.equal(item.summary.lastFoundAt, "2026-10-17T02:11:05.000Z");
  for (const day of item.days) assert.deepEqual(Object.keys(day), ["d", "s", "r", "n", "a", "t", "c", "f", "b", "k"]);
  // 일별 조회는 30일 안만, slot_minute 정렬로
  const dayQuery = state.queries.find((query) => query.table === "coupang_rank_days");
  assert.ok(dayQuery.filters.some((filter) => filter.op === "gte" && filter.column === "kst_day" && filter.value === "2026-09-18"));
});

test("GET 목록: nextCheckState 4갈래와 수집기 상태(delayed 는 활성 추적기 키워드만)", async () => {
  const state = createState({ settings: { enabled: true } });
  state.tables.coupang_rank_collectors.push({ id: uuid(500), revoked_at: null, last_seen_at: "2026-10-17T02:58:00.000Z", last_version: "1.0.0" });
  const paused = trackerRow({ keyword_key: "k-paused", product_id: "1001", status: "paused", paused_at: "2026-10-16T15:30:00.000Z", sort_order: 100 });
  const replan = trackerRow({ keyword_key: "k-replan", product_id: "1002", sort_order: 200 });
  const due = trackerRow({ keyword_key: "k-due", product_id: "1003", sort_order: 300 });
  const scheduled = trackerRow({ keyword_key: "k-scheduled", product_id: "1004", sort_order: 400 });
  state.tables.coupang_rank_trackers.push(scheduled, due, replan, paused);
  state.tables.coupang_rank_keywords.push(
    // 일시중지만 남은 키워드는 늦어도 '지연'으로 세지 않는다
    keywordRow("k-paused", { next_due_at: "2026-10-17T00:00:00.000Z" }),
    keywordRow("k-replan", { slot_ends_at: "2026-10-17T02:00:00.000Z" }),
    keywordRow("k-due", { next_due_at: "2026-10-17T02:30:00.000Z" }),
    keywordRow("k-scheduled"),
  );
  const { body } = await list(state, ownerHeaders());
  assert.deepEqual(body.trackers.map((item) => [item.productId, item.nextCheckState, item.nextCheckAt]), [
    ["1001", "paused", null],
    ["1002", "replan", null],
    ["1003", "due", "2026-10-17T02:30:00.000Z"],
    ["1004", "scheduled", "2026-10-17T07:41:00.000Z"],
  ]);
  assert.equal(body.trackers[0].pausedDay, "2026-10-17");
  assert.equal(body.collector.state, "ok");
  // 활성 추적기 키워드가 60분 넘게 밀리면 delayed
  state.tables.coupang_rank_keywords.find((row) => row.keyword_key === "k-due").next_due_at = "2026-10-17T01:59:00.000Z";
  assert.equal((await list(state, ownerHeaders())).body.collector.state, "delayed");
  // 키워드 행이 없으면 replan
  state.tables.coupang_rank_keywords = [];
  assert.ok((await list(state, ownerHeaders())).body.trackers.slice(1).every((item) => item.nextCheckState === "replan"));
});

test("inList: 모든 값을 따옴표로 감싸고 \\·\" 를 이스케이프해 PostgREST 가 그대로 읽는다", () => {
  const values = ['모니터 27" (ips)', 'tv 55", 4k', '"나이키"', "a\\b, c", 'x",남의 키워드,"y', "끝\\", "  앞뒤 공백 ", "보통 키워드", "보통 키워드"];
  const unique = [...new Set(values)];
  assert.deepEqual(parsePostgrestInList(inList(values)).values, unique);
  assert.equal(inList(["a", 'b"c']), '("a","b\\"c")');
  assert.equal(inList(["a\\b"]), '("a\\\\b")');
  assert.throws(() => inList([]), RangeError);
  // 대조: postgrest-js .in() 이 만드는 값은 PostgREST 가 다르게 읽는다(고치기 전 동작)
  assert.notDeepEqual(parsePostgrestInList(postgrestJsInValue(unique)).values, unique);
});

// 2026-10-16 통합 검수: 키워드 열쇠를 .in() 으로 넘기면 postgrest-js 가 안의 " \ 를 이스케이프하지 않아
// PostgREST 가 값을 잘못 나누고 ')' 뒤를 버린다. 그 키워드와 같은 묶음 뒤쪽 키워드 행까지 못 찾아 replan·건강 0 으로 보였다.
test("GET 목록: 큰따옴표·쉼표·괄호·역슬래시가 든 키워드도 키워드 행을 정확히 찾는다(필터 주입 없음)", async () => {
  const state = createState({ settings: { enabled: true } });
  state.tables.coupang_rank_collectors.push({ id: uuid(500), revoked_at: null, last_seen_at: "2026-10-17T02:58:00.000Z", last_version: "1.0.0" });
  const keys = [
    '모니터 27" (ips)',
    'tv 55", 4k',
    '"나이키"',
    "a\\b, c",
    'x",남의 키워드,"y',
    "끝에 역슬래시\\",
    "노트북 거치대",
    "무선 이어폰",
  ];
  keys.forEach((key, index) => {
    state.tables.coupang_rank_trackers.push(trackerRow({ keyword: key, keyword_key: key, product_id: String(2000 + index), sort_order: index }));
    state.tables.coupang_rank_keywords.push(keywordRow(key, { consecutive_failures: index, last_status: index % 2 ? "blocked" : "ok" }));
  });
  // 주입으로 끼어들면 안 되는 남의 행
  state.tables.coupang_rank_keywords.push(keywordRow("남의 키워드", { consecutive_failures: 99 }));

  const { status, body } = await list(state, ownerHeaders());
  assert.equal(status, 200);
  assert.deepEqual(
    body.trackers.map((item) => [item.keywordKey, item.nextCheckState, item.nextCheckAt, item.keywordHealth.consecutiveFailures, item.keywordHealth.lastStatus]),
    keys.map((key, index) => [key, "scheduled", "2026-10-17T07:41:00.000Z", index, index % 2 ? "blocked" : "ok"]),
  );
  const keywordFilters = state.queries
    .filter((query) => query.table === "coupang_rank_keywords")
    .map((query) => query.filters.find((filter) => filter.op === "in" && filter.column === "keyword_key"));
  assert.equal(keywordFilters.length, 1);
  // PostgREST 가 읽는 값 = 보낸 열쇠 그대로(빠짐·쪼개짐·끼어듦 없음)
  assert.deepEqual([...keywordFilters[0].value].sort(), [...keys].sort());
});

test("GET 목록: 500개 상한 — 501행이면 hasMore·complete:false, returnedCount 500", async () => {
  const state = createState();
  for (let index = 0; index < 501; index += 1) {
    state.tables.coupang_rank_trackers.push(trackerRow({ keyword_key: `k${index}`, keyword: `k${index}`, product_id: String(10000 + index), sort_order: index }));
  }
  const { status, body } = await list(state, ownerHeaders());
  assert.equal(status, 200);
  assert.deepEqual([body.returnedCount, body.totalCount, body.hasMore, body.complete], [500, 501, true, false]);
  assert.equal(body.trackers.length, 500);
  const trackerList = state.queries.find((query) => query.table === "coupang_rank_trackers");
  assert.ok(trackerList);
  // 일별은 30개씩, 키워드는 100개씩 나눠 읽는다
  const dayQueries = state.queries.filter((query) => query.table === "coupang_rank_days");
  assert.equal(dayQueries.length, Math.ceil(500 / 30));
  for (const query of dayQueries) assert.ok(query.filters.find((filter) => filter.op === "in").value.length <= 30);
  const keywordQueries = state.queries.filter((query) => query.table === "coupang_rank_keywords");
  assert.equal(keywordQueries.length, 5);
});

test("GET 목록: 하나라도 읽기에 실패하면 500(DB 문구 숨김, 기록 남김)", async () => {
  const state = createState();
  state.tables.coupang_rank_trackers.push(trackerRow());
  state.errors.push({ table: "coupang_rank_days", error: { code: "57014", message: "secret db detail: canceling statement" } });
  const logged = [];
  const original = console.error;
  console.error = (line) => logged.push(line);
  try {
    const { status, body } = await list(state, ownerHeaders());
    assert.equal(status, 500);
    assert.equal(body.code, "COUPANG_RANK_TRACKERS_FAILED");
    assert.equal(JSON.stringify(body).includes("secret"), false);
  } finally {
    console.error = original;
  }
  assert.equal(logged.length, 1);
  const entry = JSON.parse(logged[0]);
  assert.equal(entry.event, "coupang_rank_trackers_failed");
  assert.equal(entry.method, "GET");
  assert.equal(entry.view, "");
  assert.equal(entry.stage, "days");
  assert.equal(entry.errorCode, "57014");
  assert.ok(entry.requestId);
});

// ── 표 없음·메서드 ──────────────────────────────────────────────────────────

test("setupRequired: GET 200(역할 판정 전)·POST 503·access", async () => {
  const state = createState();
  delete state.tables.coupang_rank_settings;
  const listed = await list(state, ownerHeaders());
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body, {
    ok: true, setupRequired: true, trackers: [], returnedCount: 0, totalCount: 0, hasMore: false, complete: true,
    collector: { state: "setup_required" },
  });
  // 표가 없으면 역할 판정보다 먼저: 운영팀 공개 여부를 볼 수 없어도 setupRequired
  assert.equal((await list(state, teamHeaders("adv-a"))).body.setupRequired, true);
  const posted = await post(state, ownerHeaders(), { action: "create", keyword: "필름", productUrl: "8533720933" });
  assert.equal(posted.status, 503);
  assert.equal(posted.body.code, "COUPANG_SETUP_REQUIRED");
  const ownerAccess = await list(state, ownerHeaders(), "?view=access");
  assert.deepEqual(ownerAccess.body, { ok: true, open: true, role: "owner", readOnly: false, setupRequired: true });
  const teamAccess = await list(state, teamHeaders("adv-a"), "?view=access");
  assert.equal(teamAccess.body.open, false);
  assert.equal(teamAccess.body.setupRequired, true);
  assert.equal((await list(state, ownerHeaders(), "?view=collector")).body.setupRequired, true);
});

test("setupRequired: 설정 행은 있는데 함수가 없으면(PGRST202) GET 은 setupRequired, POST 는 503", async () => {
  const state = createState();
  delete state.rpc.coupang_rank_limit_status;
  const listed = await list(state, ownerHeaders());
  assert.equal(listed.status, 200);
  assert.equal(listed.body.setupRequired, true);
  const posted = await post(state, ownerHeaders(), { action: "create", keyword: "필름", productUrl: "8533720933" });
  assert.equal(posted.status, 503);
  assert.equal(posted.body.code, "COUPANG_SETUP_REQUIRED");
});

// 2026-10-16 통합 검수: 운영 경로(index.mjs → executeRequest → 공용 5xx 봉인)가 화면 POST 의 503 COUPANG_SETUP_REQUIRED 와
// 500 COUPANG_RANK_TRACKERS_FAILED 를 500 SERVER_ERROR 로 바꿔 '대표 SQL 실행 전' 문구가 뜨지 않았다.
test("운영 경로(executeRequest)를 지나도 화면 API 의 503 COUPANG_SETUP_REQUIRED·500 COUPANG_RANK_TRACKERS_FAILED 가 그대로 간다", async () => {
  const throughRuntime = async (state, method, options) => {
    const request = makeRequest(method, options);
    const response = await executeRequest(request, () => handleCoupangRankTrackersRequest(request, makeCtx(state), { now: NOW }));
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  const createBody = { action: "create", keyword: "필름", productUrl: "8533720933" };

  const noTables = createState();
  delete noTables.tables.coupang_rank_settings;
  const noFunction = createState();
  delete noFunction.rpc.coupang_rank_limit_status;
  for (const state of [noTables, noFunction]) {
    // eslint-disable-next-line no-await-in-loop
    const posted = await throughRuntime(state, "POST", { headers: ownerHeaders(), body: createBody });
    assert.equal(posted.status, 503);
    assert.equal(posted.body.code, "COUPANG_SETUP_REQUIRED");
    assert.equal(posted.body.message, "쿠팡 순위 저장소가 아직 준비되지 않았습니다(대표 SQL 실행 전).");
    assert.ok(posted.headers.get("x-request-id"));
  }

  const broken = createState();
  broken.tables.coupang_rank_trackers.push(trackerRow());
  broken.errors.push({ table: "coupang_rank_days", error: { code: "57014", message: "secret db detail: canceling statement" } });
  const original = console.error;
  console.error = () => {};
  let failed;
  try {
    failed = await throughRuntime(broken, "GET", { query: "?limit=500", headers: ownerHeaders() });
  } finally {
    console.error = original;
  }
  assert.equal(failed.status, 500);
  assert.equal(failed.body.code, "COUPANG_RANK_TRACKERS_FAILED");
  assert.equal(failed.body.message, "쿠팡 순위 요청을 처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요.");
  assert.doesNotMatch(JSON.stringify(failed.body), /secret|57014/);
});

test("메서드: GET·POST 외에는 405, 핸들러에 사전 요청 분기가 없다", async () => {
  const state = createState();
  for (const method of ["PUT", "DELETE", "PATCH", "OPTIONS"]) {
    const result = await call(state, method, { headers: ownerHeaders() });
    assert.equal(result.status, 405, method);
    assert.equal(result.body.code, "METHOD_NOT_ALLOWED");
  }
  assert.equal(HANDLER_SOURCE.includes('"OPTIONS"'), false);
  assert.equal(HANDLER_SOURCE.includes("'OPTIONS'"), false);
  assert.match(HANDLER_SOURCE, /withSupabase\(\{ auth: "none", cors: false \}, handleCoupangRankTrackersRequest\)/);
});

test("handler import 는 §2.1 허용 목록뿐", () => {
  const imports = [...HANDLER_SOURCE.matchAll(/^import[\s\S]*?from\s+"([^"]+)";/gmu)].map((match) => match[1]);
  const allowed = new Set(["@supabase/server", "../security.mjs", "../owner-identity.mjs", "../runtime.mjs"]);
  for (const specifier of imports) {
    assert.ok(allowed.has(specifier) || /^\.\.\/coupang-rank\/[a-z-]+\.mjs$/.test(specifier), specifier);
  }
  assert.equal(HANDLER_SOURCE.includes("naver_"), false);
});

test("POST 본문: 32KB 초과 413, JSON 아님·객체 아님·모르는 action 은 400", async () => {
  const state = createState();
  const declared = await call(state, "POST", {
    headers: { ...ownerHeaders(), "content-length": "40000" }, body: { action: "pause", ids: [uuid(1)] },
  });
  assert.equal(declared.status, 413);
  assert.equal(declared.body.code, "BODY_TOO_LARGE");
  const actual = await call(state, "POST", { headers: ownerHeaders(), body: { action: "pause", ids: [uuid(1)], pad: "가".repeat(11000) } });
  assert.equal(actual.status, 413);
  for (const rawBody of ["{", "[]", "null", "\"pause\""]) {
    const result = await call(state, "POST", { headers: ownerHeaders(), rawBody, contentType: "application/json" });
    assert.equal(result.status, 400, rawBody);
    assert.equal(result.body.code, "COUPANG_ACTION_INVALID");
  }
  const form = await call(state, "POST", { headers: ownerHeaders(), rawBody: "action=pause", contentType: "application/x-www-form-urlencoded" });
  assert.equal(form.body.code, "COUPANG_ACTION_INVALID");
  const unknown = await post(state, ownerHeaders(), { action: "check-now" });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.code, "COUPANG_ACTION_INVALID");
  const badView = await list(state, ownerHeaders(), "?view=everything");
  assert.equal(badView.body.code, "COUPANG_ACTION_INVALID");
});

// ── view=access ───────────────────────────────────────────────────────────

test("GET ?view=access: 꺼져 있어도 403 이 아니라 open:false", async () => {
  const closed = createState({ settings: { team_access_enabled: false, client_view_enabled: false } });
  assert.deepEqual((await list(closed, ownerHeaders(), "?view=access")).body, { ok: true, open: true, role: "owner", readOnly: false, setupRequired: false });
  assert.deepEqual((await list(closed, teamHeaders("adv-a"), "?view=access")).body, { ok: true, open: false, role: "team", readOnly: false, setupRequired: false });
  assert.deepEqual((await list(closed, clientHeaders("adv-a"), "?view=access")).body, { ok: true, open: false, role: "client", readOnly: true, setupRequired: false });
  const open = createState();
  assert.equal((await list(open, teamHeaders("adv-a"), "?view=access")).body.open, true);
  assert.equal((await list(open, clientHeaders("adv-a"), "?view=access")).body.open, true);
  assert.equal((await list(open, { ...ownerHeaders(), "x-mi-owner-agency-code": "x" }, "?view=access")).body.open, false);
  assert.equal((await list(open, {}, "?view=access")).status, 401);
});

// ── view=runs ─────────────────────────────────────────────────────────────

test("GET ?view=runs: 최근 30일 스냅샷과 같은 키워드의 14일 실패 회차만, 쪽 목록은 보내지 않는다", async () => {
  const state = createState();
  const tracker = trackerRow();
  state.tables.coupang_rank_trackers.push(tracker);
  state.tables.coupang_rank_snapshots.push(
    { id: uuid(700), tracker_id: tracker.id, run_id: uuid(800), checked_at: "2026-10-17T02:11:05.000Z", kst_day: "2026-10-17", slot_index: 0, slot_minute: 480, result: "found", rank: 28, organic_count: 50, organic_slot: 38, ad_order: 8, same_option: true, title: "제목" },
    { id: uuid(701), tracker_id: tracker.id, run_id: uuid(801), checked_at: "2026-09-01T02:11:05.000Z", kst_day: "2026-09-01", slot_index: 0, slot_minute: 480, result: "found", rank: 2, organic_count: 50, organic_slot: 2, ad_order: null, same_option: true },
  );
  state.tables.coupang_rank_runs.push(
    { id: uuid(900), keyword_key: tracker.keyword_key, status: "timeout", error_code: "page_timeout", slot_index: 1, claimed_at: "2026-10-16T09:20:00.000Z", organic: [{ p: "9999", v: "", s: 1 }] },
    { id: uuid(901), keyword_key: tracker.keyword_key, status: "ok", error_code: null, slot_index: 0, claimed_at: "2026-10-17T02:11:00.000Z" },
    { id: uuid(902), keyword_key: tracker.keyword_key, status: "released", error_code: null, slot_index: 0, claimed_at: "2026-10-17T02:00:00.000Z" },
    { id: uuid(903), keyword_key: tracker.keyword_key, status: "blocked", error_code: null, slot_index: 0, claimed_at: "2026-09-30T00:00:00.000Z" },
    { id: uuid(904), keyword_key: "다른 키워드", status: "error", error_code: "cdp_error", slot_index: 0, claimed_at: "2026-10-17T01:00:00.000Z" },
  );
  const { status, body } = await list(state, ownerHeaders(), `?view=runs&trackerId=${tracker.id.toUpperCase()}`);
  assert.equal(status, 200);
  assert.deepEqual(body, {
    ok: true,
    trackerId: tracker.id,
    snapshots: [{ checkedAt: "2026-10-17T02:11:05.000Z", day: "2026-10-17", slot: 0, result: "found", rank: 28, organicCount: 50, organicSlot: 38, adOrder: 8, sameOption: true }],
    failures: [{ claimedAt: "2026-10-16T09:20:00.000Z", status: "timeout", errorCode: "page_timeout", slot: 1 }],
  });
  assert.equal((await list(state, ownerHeaders(), "?view=runs&trackerId=nope")).status, 404);
  assert.equal((await list(state, ownerHeaders(), `?view=runs&trackerId=${uuid(1)}`)).body.code, "COUPANG_TRACKER_NOT_FOUND");
});

// ── create ────────────────────────────────────────────────────────────────

test("create: 새 등록 — 정규화된 값으로 insert, after_activate, firstCheck queued, 응답 limit.capacity", async () => {
  const state = createState();
  state.tables.coupang_rank_trackers.push(trackerRow({ agency_code: "adv-a", client_id: CLIENT_A, keyword_key: "기존", product_id: "1234", sort_order: 300 }));
  const { status, body } = await post(state, teamHeaders("adv-a"), {
    action: "create",
    keyword: "  iPhone 18 Pro　사생활  필름 ",
    productUrl: "https://www.coupang.com/vp/products/8533720933?itemId=1&vendorItemId=96009802650",
    groupName: " 필름 ",
  });
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body), ["ok", "tracker", "firstCheck", "limit"]);
  assert.equal(body.firstCheck, "queued");
  assert.deepEqual(body.limit, { used: 2, max: 20, globalUsed: 2, globalMax: 150, capacity: 60 });
  const insert = state.queries.find((query) => query.table === "coupang_rank_trackers" && query.operation === "insert");
  assert.deepEqual(insert.values, {
    agency_code: "adv-a",
    client_id: CLIENT_A,
    keyword: "iPhone 18 Pro 사생활 필름",
    keyword_key: "iphone 18 pro 사생활 필름",
    product_id: "8533720933",
    product_url: "https://www.coupang.com/vp/products/8533720933",
    vendor_item_id: "96009802650",
    group_name: "필름",
    sort_order: 400,
    created_by: "team",
  });
  assert.equal(body.tracker.keyword, "iPhone 18 Pro 사생활 필름");
  assert.equal(body.tracker.status, "active");
  assert.equal(body.tracker.current, null);
  assert.deepEqual(body.tracker.days, []);
  assert.equal(body.tracker.nextCheckState, "scheduled");
  assert.equal(body.tracker.nextCheckAt, "2026-10-17T03:05:00.000Z");
  const activate = state.rpcCalls.find((entry) => entry.name === "coupang_rank_after_activate");
  assert.deepEqual(activate.args, { p_tracker_id: body.tracker.id });
  const preCheck = state.rpcCalls.find((entry) => entry.name === "coupang_rank_limit_status");
  assert.deepEqual(preCheck.args, { p_agency_code: "adv-a", p_keyword_key: "iphone 18 pro 사생활 필름" });
});

test("create: 첫 등록은 sort_order 100, 그룹 생략은 기본 그룹, 총관리자는 created_by owner·client_id null, firstCheck recorded", async () => {
  const state = createState();
  state.firstCheck = "recorded";
  const { body } = await post(state, ownerHeaders(), { action: "create", keyword: "필름", productUrl: "m.coupang.com/vm/products/8533720933" });
  assert.equal(body.firstCheck, "recorded");
  const insert = state.queries.find((query) => query.operation === "insert");
  assert.equal(insert.values.sort_order, 100);
  assert.equal(insert.values.group_name, "기본 그룹");
  assert.equal(insert.values.created_by, "owner");
  assert.equal(insert.values.client_id, null);
  assert.equal(insert.values.vendor_item_id, null);
  assert.equal(body.limit.max, 100);
});

test("create: 옵션(vendorItemId)만 다르면 같은 상품이라 alreadyTracking", async () => {
  const state = createState();
  state.tables.coupang_rank_trackers.push(trackerRow({ vendor_item_id: "96009802650" }));
  const { status, body } = await post(state, ownerHeaders(), {
    action: "create",
    keyword: "아이폰 18프로 사생활 보호 필름",
    productUrl: "https://www.coupang.com/vp/products/8533720933?vendorItemId=11111111111",
  });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.alreadyTracking, true);
  assert.equal(body.tracker.vendorItemId, "96009802650");
  assert.equal(state.queries.filter((query) => query.operation === "insert").length, 0);
  assert.equal(state.rpcCalls.filter((entry) => entry.name === "coupang_rank_after_activate").length, 0);
});

test("create: 짧은 링크·검색 주소·키워드·그룹 거절", async () => {
  const state = createState();
  const cases = [
    [{ keyword: "필름", productUrl: "https://link.coupang.com/a/bCdEf" }, "COUPANG_SHORT_LINK_UNSUPPORTED"],
    [{ keyword: "필름", productUrl: "https://www.coupang.com/np/search?q=필름" }, "COUPANG_NOT_PRODUCT_URL"],
    [{ keyword: "필름", productUrl: "" }, "COUPANG_PRODUCT_URL_REQUIRED"],
    [{ keyword: " ", productUrl: "8533720933" }, "COUPANG_KEYWORD_REQUIRED"],
    [{ keyword: "https://www.coupang.com/vp/products/1", productUrl: "8533720933" }, "COUPANG_KEYWORD_INVALID"],
    [{ keyword: "필름", productUrl: "8533720933", groupName: "가".repeat(31) }, "COUPANG_GROUP_INVALID"],
  ];
  for (const [input, code] of cases) {
    const result = await post(state, ownerHeaders(), { action: "create", ...input });
    assert.equal(result.status, 400, code);
    assert.equal(result.body.code, code);
    assert.ok(result.body.message);
  }
  assert.equal(state.queries.filter((query) => query.operation === "insert").length, 0);
});

test("create: 일시중지 행은 다시 시작(그룹 변경 포함) → resumed, 트리거 한도 오류는 403", async () => {
  const state = createState();
  const paused = trackerRow({ status: "paused", paused_at: "2026-10-15T00:00:00.000Z" });
  state.tables.coupang_rank_trackers.push(paused);
  const { status, body } = await post(state, ownerHeaders(), {
    action: "create", keyword: "아이폰 18프로 사생활 보호 필름", productUrl: "8533720933", groupName: "다시",
  });
  assert.equal(status, 200);
  assert.equal(body.resumed, true);
  assert.equal(body.firstCheck, "queued");
  assert.ok(body.limit);
  assert.equal(paused.status, "active");
  assert.equal(paused.paused_at, null);
  assert.equal(paused.group_name, "다시");
  assert.ok(state.rpcCalls.some((entry) => entry.name === "coupang_rank_after_activate" && entry.args.p_tracker_id === paused.id));

  // 그룹을 안 보내면 그룹은 그대로
  const keep = createState();
  const keepRow = trackerRow({ status: "paused", paused_at: NOW, group_name: "원래" });
  keep.tables.coupang_rank_trackers.push(keepRow);
  await post(keep, ownerHeaders(), { action: "create", keyword: keepRow.keyword, productUrl: "8533720933" });
  assert.equal(keepRow.group_name, "원래");

  // 다시 시작할 때 트리거가 한도로 막으면 403 + limit·count
  const limited = createState();
  const limitedRow = trackerRow({ status: "paused", paused_at: NOW });
  limited.tables.coupang_rank_trackers.push(limitedRow);
  limited.guard = (table, operation, next, previous) => (table === "coupang_rank_trackers" && operation === "update" && next.status === "active" && previous?.status === "paused"
    ? { code: "P0001", message: "COUPANG_KEYWORD_LIMIT_REACHED", details: "20", hint: "20" }
    : null);
  const blocked = await post(limited, ownerHeaders(), { action: "create", keyword: limitedRow.keyword, productUrl: "8533720933" });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.code, "COUPANG_KEYWORD_LIMIT_REACHED");
  assert.equal(blocked.body.limit, 20);
  assert.equal(blocked.body.count, 20);
  assert.equal(limitedRow.status, "paused");
});

test("create: 사전 한도 검사 403(계정·전체), 이미 수집 중인 키워드는 전체 한도와 무관", async () => {
  const account = createState();
  account.tables.coupang_rank_account_limits.push({ agency_code: "adv-a", keyword_limit: 1 });
  account.tables.coupang_rank_trackers.push(trackerRow({ agency_code: "adv-a", client_id: CLIENT_A, keyword_key: "a", product_id: "1111" }));
  const accountLimit = await post(account, teamHeaders("adv-a"), { action: "create", keyword: "b", productUrl: "2222" });
  assert.equal(accountLimit.status, 403);
  assert.deepEqual(
    { code: accountLimit.body.code, limit: accountLimit.body.limit, count: accountLimit.body.count },
    { code: "COUPANG_KEYWORD_LIMIT_REACHED", limit: 1, count: 1 },
  );

  const global = createState({ settings: { global_keyword_limit: 2 } });
  global.tables.coupang_rank_trackers.push(
    trackerRow({ agency_code: "adv-b", client_id: CLIENT_B, keyword_key: "x", product_id: "1111" }),
    trackerRow({ agency_code: "adv-b", client_id: CLIENT_B, keyword_key: "y", product_id: "2222" }),
  );
  const globalLimit = await post(global, teamHeaders("adv-a"), { action: "create", keyword: "z", productUrl: "3333" });
  assert.equal(globalLimit.status, 403);
  assert.deepEqual(
    { code: globalLimit.body.code, limit: globalLimit.body.limit, count: globalLimit.body.count },
    { code: "COUPANG_GLOBAL_KEYWORD_LIMIT_REACHED", limit: 2, count: 2 },
  );
  const shared = await post(global, teamHeaders("adv-a"), { action: "create", keyword: "X", productUrl: "4444" });
  assert.equal(shared.status, 200, "같은 키워드를 이미 수집 중이면 전체 한도에 걸리지 않음");
  assert.equal(account.queries.filter((query) => query.operation === "insert").length, 0);
});

test("create: insert 트리거 P0001 두 종류 → 같은 이름의 403(limit = details, count = hint)", async () => {
  for (const [message, details, hint] of [["COUPANG_KEYWORD_LIMIT_REACHED", "20", "20"], ["COUPANG_GLOBAL_KEYWORD_LIMIT_REACHED", "150", "150"]]) {
    const state = createState();
    state.guard = (table, operation) => (table === "coupang_rank_trackers" && operation === "insert" ? { code: "P0001", message, details, hint } : null);
    const { status, body } = await post(state, ownerHeaders(), { action: "create", keyword: "경합", productUrl: "8533720933" });
    assert.equal(status, 403, message);
    assert.equal(body.code, message);
    assert.equal(body.limit, Number(details));
    assert.equal(body.count, Number(hint));
    assert.equal(state.rpcCalls.filter((entry) => entry.name === "coupang_rank_after_activate").length, 0);
  }
});

test("create: 23505(경합) → 다시 읽어 alreadyTracking", async () => {
  const state = createState();
  state.errors.push({
    table: "coupang_rank_trackers",
    operation: "insert",
    once: true,
    error: { code: "23505", message: "duplicate" },
    when: () => {
      // 다른 요청이 같은 순간 먼저 넣었다
      state.tables.coupang_rank_trackers.push(trackerRow({ keyword: "경합", keyword_key: "경합" }));
      return true;
    },
  });
  const { status, body } = await post(state, ownerHeaders(), { action: "create", keyword: "경합", productUrl: "8533720933" });
  assert.equal(status, 200);
  assert.equal(body.alreadyTracking, true);
  assert.equal(body.tracker.keywordKey, "경합");
});

// ── pause·resume·delete·group ─────────────────────────────────────────────

test("pause·delete·group: 활성만 중지, 완전 삭제(일별 칸 cascade), 그룹 정규화", async () => {
  const state = createState();
  const one = trackerRow({ product_id: "1001" });
  const two = trackerRow({ product_id: "1002", status: "paused", paused_at: "2026-10-15T00:00:00.000Z" });
  state.tables.coupang_rank_trackers.push(one, two);
  state.tables.coupang_rank_days.push({ tracker_id: one.id, kst_day: "2026-10-17", slot_minute: 480, result: "found", rank: 3, checked_at: NOW });
  const paused = await post(state, ownerHeaders(), { action: "pause", ids: [one.id, two.id, one.id.toUpperCase()] });
  assert.deepEqual(paused.body, { ok: true, updated: 1 });
  assert.equal(one.status, "paused");
  assert.equal(one.paused_at, NOW);
  assert.equal(two.paused_at, "2026-10-15T00:00:00.000Z", "이미 중지된 것은 그대로");
  const grouped = await post(state, ownerHeaders(), { action: "group", id: one.id, groupName: "  새　그룹 " });
  assert.deepEqual(grouped.body, { ok: true, updated: 1 });
  assert.equal(one.group_name, "새 그룹");
  const removed = await post(state, ownerHeaders(), { action: "delete", ids: [one.id] });
  assert.deepEqual(removed.body, { ok: true, deleted: 1 });
  assert.equal(state.tables.coupang_rank_days.length, 0);
  for (const body of [{ action: "pause" }, { action: "pause", ids: ["x"] }, { action: "delete", ids: [] }, { action: "group", ids: Array.from({ length: 101 }, (_, n) => uuid(n)) }]) {
    const result = await post(state, ownerHeaders(), body);
    assert.equal(result.status, 400);
    assert.equal(result.body.code, "COUPANG_IDS_INVALID");
  }
});

test("resume: id 마다 순서대로, 도중 한도 오류면 그 자리에서 멈추고 stoppedAt(앞의 것은 다시 시작됨)", async () => {
  const state = createState();
  const first = trackerRow({ product_id: "1001", status: "paused", paused_at: NOW });
  const second = trackerRow({ product_id: "1002", status: "paused", paused_at: NOW });
  const third = trackerRow({ product_id: "1003", status: "paused", paused_at: NOW });
  state.tables.coupang_rank_trackers.push(first, second, third);
  state.guard = (table, operation, next) => (table === "coupang_rank_trackers" && operation === "update" && next.id === second.id && next.status === "active"
    ? { code: "P0001", message: "COUPANG_GLOBAL_KEYWORD_LIMIT_REACHED", details: "150", hint: "150" }
    : null);
  const { status, body } = await post(state, ownerHeaders(), { action: "resume", ids: [first.id, second.id, third.id] });
  assert.equal(status, 200);
  assert.deepEqual(body, {
    ok: true,
    updated: 1,
    stoppedAt: { id: second.id, code: "COUPANG_GLOBAL_KEYWORD_LIMIT_REACHED", limit: 150, count: 150 },
  });
  assert.equal(first.status, "active");
  assert.equal(first.paused_at, null);
  assert.equal(second.status, "paused");
  assert.equal(third.status, "paused");
  assert.deepEqual(state.rpcCalls.filter((entry) => entry.name === "coupang_rank_after_activate").map((entry) => entry.args.p_tracker_id), [first.id]);
  state.guard = null;
  const rest = await post(state, ownerHeaders(), { action: "resume", ids: [first.id, second.id, third.id] });
  assert.deepEqual(rest.body, { ok: true, updated: 2 });
});

// ── 총관리자 전용 ─────────────────────────────────────────────────────────

test("총관리자 전용 동작·조회: 운영팀은 OWNER_ONLY(공개 꺼짐이면 TEAM_NOT_OPEN)", async () => {
  const state = createState();
  for (const action of ["settings-update", "collector-enable", "collector-disable", "cooldown-clear", "account-limit-set", "collector-token-create", "collector-token-revoke"]) {
    const result = await post(state, teamHeaders("adv-a"), { action, settings: { maxRunsPerHour: 6 } });
    assert.equal(result.status, 403, action);
    assert.equal(result.body.code, "COUPANG_OWNER_ONLY", action);
  }
  assert.equal((await list(state, teamHeaders("adv-a"), "?view=collector")).body.code, "COUPANG_OWNER_ONLY");
  assert.equal((await list(state, clientHeaders("adv-a"), "?view=collector")).body.code, "COUPANG_OWNER_ONLY");
  const closed = createState({ settings: { team_access_enabled: false } });
  assert.equal((await post(closed, teamHeaders("adv-a"), { action: "collector-enable" })).body.code, "COUPANG_TEAM_NOT_OPEN");
  // 총관리자 전용 조회는 대상 범위와 무관하다(해제된 광고주를 고른 채여도 패널이 열린다)
  const owner = await list(state, ownerHeaders("adv-gone"), "?view=collector");
  assert.equal(owner.status, 200);
});

test("settings-update: 범위 오류 400 {field}, 내리기는 집계 없이 바로, updated_by owner, rate_changed_at 유지", async () => {
  const state = createState();
  const invalid = await post(state, ownerHeaders(), { action: "settings-update", settings: { maxRunsPerHour: 0 } });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.code, "COUPANG_SETTINGS_INVALID");
  assert.equal(invalid.body.field, "maxRunsPerHour");
  const unknown = await post(state, ownerHeaders(), { action: "settings-update", settings: { enabled: true } });
  assert.equal(unknown.body.field, "enabled");
  const missing = await post(state, ownerHeaders(), { action: "settings-update" });
  assert.equal(missing.body.field, "settings");

  const lowered = await post(state, ownerHeaders(), { action: "settings-update", settings: { maxRunsPerHour: 6, windowMode: "normal" } });
  assert.equal(lowered.status, 200);
  assert.equal(lowered.body.settings.maxRunsPerHour, 6);
  assert.equal(lowered.body.settings.windowMode, "normal");
  assert.equal(lowered.body.replanned, 0);
  const row = state.tables.coupang_rank_settings[0];
  assert.equal(row.updated_by, "owner");
  assert.equal(row.rate_changed_at, "2026-10-14T00:00:00.000Z");
  assert.equal(state.rpcCalls.filter((entry) => entry.name === "coupang_rank_stats").length, 0);
  assert.equal(state.rpcCalls.filter((entry) => entry.name === "coupang_rank_replan_all").length, 0);
});

test("settings-update: 상향 4조건(확인·48시간 차단/빈 쪽/성공·조용한 48시간·사다리)과 6→12", async () => {
  const unconfirmed = createState();
  const noConfirm = await post(unconfirmed, ownerHeaders(), { action: "settings-update", settings: { maxRunsPerHour: 24 } });
  assert.equal(noConfirm.status, 400);
  assert.equal(noConfirm.body.code, "COUPANG_RAISE_CONFIRM_REQUIRED");
  assert.equal(unconfirmed.tables.coupang_rank_settings[0].max_runs_per_hour, 12);

  const blocked = createState();
  blocked.stats = { blocked48h: 1, empty48h: 0, success48h: 60 };
  const blockedResult = await post(blocked, ownerHeaders(), { action: "settings-update", settings: { maxRunsPerHour: 24 }, confirmRaise: true });
  assert.equal(blockedResult.status, 409);
  assert.equal(blockedResult.body.code, "COUPANG_RAISE_NOT_ALLOWED");
  assert.deepEqual(blockedResult.body.reasons, ["blocked_or_empty_48h"]);
  for (const key of ["blocked48h", "empty48h", "success48h", "hoursSinceRateChange", "nextStep"]) assert.ok(Object.hasOwn(blockedResult.body, key), key);
  assert.equal(blockedResult.body.nextStep, 24);

  const few = createState();
  few.stats = { blocked48h: 0, empty48h: 0, success48h: 47 };
  assert.deepEqual((await post(few, ownerHeaders(), { action: "settings-update", settings: { maxRunsPerDay: 200 }, confirmRaise: true })).body.reasons, ["too_few_success_48h"]);

  const recent = createState({ settings: { rate_changed_at: "2026-10-16T12:00:00.000Z" } });
  assert.deepEqual((await post(recent, ownerHeaders(), { action: "settings-update", settings: { minGapSeconds: 120 }, confirmRaise: true })).body.reasons, ["quiet_window_short"]);

  const ladder = createState();
  assert.deepEqual((await post(ladder, ownerHeaders(), { action: "settings-update", settings: { maxRunsPerHour: 40 }, confirmRaise: true })).body.reasons, ["ladder_step"]);

  const six = createState({ settings: { max_runs_per_hour: 6 } });
  const raised = await post(six, ownerHeaders(), { action: "settings-update", settings: { maxRunsPerHour: 12 }, confirmRaise: true });
  assert.equal(raised.status, 200);
  assert.equal(raised.body.settings.maxRunsPerHour, 12);
  assert.equal(six.tables.coupang_rank_settings[0].rate_changed_at, NOW);
  assert.equal(raised.body.settings.rateChangedAt, NOW);
  assert.equal(six.rpcCalls.filter((entry) => entry.name === "coupang_rank_stats").length, 1);
});

test("settings-update: 하루 횟수·수집 시간대가 바뀌면 replan_all 을 부르고 건수를 돌려준다", async () => {
  const state = createState();
  const result = await post(state, ownerHeaders(), { action: "settings-update", settings: { checksPerDay: 3, activeToHour: 22 } });
  assert.equal(result.status, 200);
  assert.equal(result.body.replanned, 7);
  assert.equal(result.body.settings.checksPerDay, 3);
  assert.equal(state.rpcCalls.filter((entry) => entry.name === "coupang_rank_replan_all").length, 1);
  // 넓히는 시간대 변경은 상향이라 확인이 필요하다
  const widen = await post(state, ownerHeaders(), { action: "settings-update", settings: { activeFromHour: 7 } });
  assert.equal(widen.body.code, "COUPANG_RAISE_CONFIRM_REQUIRED");
  // 전체 한도를 줄여도(용량에 맞추기) 이미 활성인 추적기는 그대로
  state.tables.coupang_rank_trackers.push(trackerRow());
  const fit = await post(state, ownerHeaders(), { action: "settings-update", settings: { globalKeywordLimit: 1 } });
  assert.equal(fit.body.settings.globalKeywordLimit, 1);
  assert.equal(state.tables.coupang_rank_trackers[0].status, "active");
});

test("collector-enable·disable·cooldown-clear", async () => {
  const state = createState({
    settings: {
      cooldown_until: "2026-10-17T09:00:00.000Z", cooldown_reason: "blocked", needs_owner_review: true, review_reason: "blocked_x3",
      budget_blocked: true, budget_reason: "storage", error_streak: 2, empty_streak: 1,
    },
  });
  const none = await post(state, ownerHeaders(), { action: "collector-enable" });
  assert.equal(none.status, 409);
  assert.equal(none.body.code, "COUPANG_NO_COLLECTOR");
  state.tables.coupang_rank_collectors.push({ id: uuid(500), revoked_at: "2026-10-01T00:00:00.000Z", token_sha256: "a".repeat(64) });
  assert.equal((await post(state, ownerHeaders(), { action: "collector-enable" })).body.code, "COUPANG_NO_COLLECTOR", "폐기된 코드는 세지 않음");
  state.tables.coupang_rank_collectors.push({ id: uuid(501), revoked_at: null, token_sha256: "b".repeat(64) });
  const enabled = await post(state, ownerHeaders(), { action: "collector-enable" });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.settings.enabled, true);
  assert.equal(state.tables.coupang_rank_settings[0].updated_by, "owner");
  const disabled = await post(state, ownerHeaders(), { action: "collector-disable" });
  assert.equal(disabled.body.settings.enabled, false);

  state.tables.coupang_rank_cooldowns.push(
    { id: uuid(1), reason: "blocked", started_at: "2026-10-17T02:00:00.000Z", ends_at: "2026-10-17T08:00:00.000Z", cleared_at: null, cleared_by: null },
    { id: uuid(2), reason: "blocked", started_at: "2026-10-12T02:00:00.000Z", ends_at: "2026-10-12T08:00:00.000Z", cleared_at: "2026-10-12T05:00:00.000Z", cleared_by: "owner" },
  );
  const cleared = await post(state, ownerHeaders(), { action: "cooldown-clear" });
  assert.equal(cleared.status, 200);
  const row = state.tables.coupang_rank_settings[0];
  assert.deepEqual(
    [row.cooldown_until, row.cooldown_reason, row.needs_owner_review, row.review_reason, row.budget_blocked, row.budget_reason, row.error_streak, row.empty_streak],
    [null, null, false, null, false, null, 0, 0],
  );
  assert.equal(cleared.body.settings.cooldownUntil, null);
  // 7일 차단 횟수(쉬기 기록)는 지우지 않고 해제 표시만
  assert.equal(state.tables.coupang_rank_cooldowns.length, 2);
  assert.equal(state.tables.coupang_rank_cooldowns[0].cleared_at, NOW);
  assert.equal(state.tables.coupang_rank_cooldowns[0].cleared_by, "owner");
  assert.equal(state.tables.coupang_rank_cooldowns[1].cleared_at, "2026-10-12T05:00:00.000Z");
});

test("account-limit-set: 코드 검사·0~1000·null 이면 지움, 응답은 accountLimits(kind·label)", async () => {
  const state = createState();
  for (const body of [
    { agencyCode: "", keywordLimit: 5 },
    { agencyCode: "-bad", keywordLimit: 5 },
    { agencyCode: "a b", keywordLimit: 5 },
    { agencyCode: "adv-a", keywordLimit: 1001 },
    { agencyCode: "adv-a", keywordLimit: -1 },
    { agencyCode: "adv-a", keywordLimit: 1.5 },
    { agencyCode: "adv-a" },
  ]) {
    const result = await post(state, ownerHeaders(), { action: "account-limit-set", ...body });
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.equal(result.body.code, "COUPANG_LIMIT_INVALID");
  }
  const set = await post(state, ownerHeaders(), { action: "account-limit-set", agencyCode: "ADV-A", keywordLimit: 30 });
  assert.equal(set.status, 200);
  await post(state, ownerHeaders(), { action: "account-limit-set", agencyCode: "team-x1", keywordLimit: 0 });
  const last = await post(state, ownerHeaders(), { action: "account-limit-set", agencyCode: "ghost-1", keywordLimit: 1000 });
  assert.deepEqual(last.body.accountLimits, [
    { agencyCode: "adv-a", keywordLimit: 30, kind: "advertiser", label: "광고주 A" },
    { agencyCode: "ghost-1", keywordLimit: 1000, kind: "unknown", label: "연결 없음" },
    { agencyCode: PRIMARY, keywordLimit: 100, kind: "owner", label: "총관리자" },
    { agencyCode: "team-x1", keywordLimit: 0, kind: "team", label: "팀 X" },
  ]);
  assert.equal(state.tables.coupang_rank_account_limits.find((row) => row.agency_code === "adv-a").updated_by, "owner");
  const updated = await post(state, ownerHeaders(), { action: "account-limit-set", agencyCode: "adv-a", keywordLimit: 31 });
  assert.equal(updated.body.accountLimits[0].keywordLimit, 31);
  const removed = await post(state, ownerHeaders(), { action: "account-limit-set", agencyCode: "ghost-1", keywordLimit: null });
  assert.equal(removed.body.accountLimits.some((row) => row.agencyCode === "ghost-1"), false);
});

test("collector-token-create: 상한 3개·원문 1회·해시만 저장·hint·기존 코드 유지 / revoke", async () => {
  const state = createState();
  const created = [];
  for (let index = 0; index < 3; index += 1) {
    const result = await post(state, ownerHeaders(), { action: "collector-token-create", label: index === 0 ? " 윈도우 데스크탑 " : undefined });
    assert.equal(result.status, 200);
    assert.deepEqual(Object.keys(result.body), ["ok", "id", "label", "token", "tokenHint"]);
    assert.match(result.body.token, COLLECTOR_TOKEN_PATTERN);
    assert.equal(result.body.tokenHint, result.body.token.slice(-4));
    created.push(result.body);
  }
  assert.equal(created[0].label, "윈도우 데스크탑");
  assert.equal(created[1].label, "수집기");
  const rows = state.tables.coupang_rank_collectors;
  assert.equal(rows.length, 3);
  for (const [index, row] of rows.entries()) {
    assert.equal(row.token_sha256, createHash("sha256").update(created[index].token, "utf8").digest("hex"));
    assert.equal(row.token_hint, created[index].tokenHint);
    assert.equal(row.revoked_at, null, "기존 코드를 폐기하지 않는다");
    assert.equal(JSON.stringify(row).includes(created[index].token), false, "원문은 저장하지 않는다");
    assert.equal(row.created_by, "owner");
  }
  const fourth = await post(state, ownerHeaders(), { action: "collector-token-create" });
  assert.equal(fourth.status, 409);
  assert.equal(fourth.body.code, "COUPANG_COLLECTOR_LIMIT");
  for (const label of ["가".repeat(41), 7, ["x"]]) {
    const bad = await post(state, ownerHeaders(), { action: "collector-token-create", label });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, "COUPANG_COLLECTOR_LABEL_INVALID");
  }
  // 패널 목록에는 원문·해시가 없다
  const panel = await list(state, ownerHeaders(), "?view=collector");
  assert.equal(JSON.stringify(panel.body).includes(created[0].token), false);
  assert.equal(JSON.stringify(panel.body).includes(rows[0].token_sha256), false);

  const revoked = await post(state, ownerHeaders(), { action: "collector-token-revoke", id: created[0].id });
  assert.deepEqual(revoked.body, { ok: true, revokedAt: NOW });
  assert.equal(rows[0].revoked_at, NOW);
  const again = await post(state, ownerHeaders(), { action: "collector-token-revoke", id: created[0].id });
  assert.deepEqual(again.body, { ok: true, revokedAt: NOW });
  assert.equal((await post(state, ownerHeaders(), { action: "collector-token-revoke", id: uuid(4242) })).body.code, "COUPANG_COLLECTOR_NOT_FOUND");
  assert.equal((await post(state, ownerHeaders(), { action: "collector-token-revoke", id: "x" })).status, 404);
  // 폐기했으니 다시 하나 만들 수 있다
  assert.equal((await post(state, ownerHeaders(), { action: "collector-token-create" })).status, 200);
});

test("GET ?view=collector: release·설정·수집기·한도·집계·용량·상향·복사 줄", async () => {
  const previous = process.env.VERCEL_GIT_COMMIT_SHA;
  try {
    const state = createState({ settings: { rate_changed_at: "2026-10-10T00:00:00.000Z" } });
    state.tables.coupang_rank_collectors.push({
      id: uuid(500), label: "윈도우 데스크탑", token_sha256: "c".repeat(64), token_hint: "x9Qa", platform: "windows",
      created_at: "2026-10-16T00:00:00.000Z", revoked_at: null, last_seen_at: "2026-10-17T02:58:00.000Z", last_version: "1.0.0",
      last_node: "22.12.0", last_browser: "edge 141.0.3537.71", last_os: "Windows 10.0.26100", last_guard: "none",
      last_claim_at: "2026-10-17T02:59:00.000Z", last_claim_reply: { ok: true, state: "wait", reason: "gap", retryAfterSec: 200 },
    });
    process.env.VERCEL_GIT_COMMIT_SHA = "abc1234def5678";
    const { status, body } = await list(state, ownerHeaders(), "?view=collector");
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(body), ["ok", "release", "bundleVersion", "settings", "collectors", "accountLimits", "stats", "capacity", "raise", "oneLiners"]);
    assert.equal(body.release, "abc1234");
    assert.equal(body.bundleVersion, "1.0.0");
    assert.equal(body.settings.windowMode, "offscreen");
    assert.deepEqual(body.collectors, [{
      id: uuid(500), label: "윈도우 데스크탑", tokenHint: "x9Qa", platform: "windows", createdAt: "2026-10-16T00:00:00.000Z",
      revokedAt: null, lastSeenAt: "2026-10-17T02:58:00.000Z", lastVersion: "1.0.0", lastNode: "22.12.0",
      lastBrowser: "edge 141.0.3537.71", lastOs: "Windows 10.0.26100", lastGuard: "none", lastClaimAt: "2026-10-17T02:59:00.000Z",
      lastClaimReason: "gap",
    }]);
    assert.deepEqual(body.accountLimits, [{ agencyCode: PRIMARY, keywordLimit: 100, kind: "owner", label: "총관리자" }]);
    assert.deepEqual(body.stats, state.stats);
    assert.deepEqual(body.capacity, { runsPerDay: 120, keywordsAtChecks: 60, activeKeywords: 41, over: false });
    assert.equal(body.raise.allowed, true);
    assert.equal(body.raise.nextStep, 24);
    assert.deepEqual(body.raise.reasons, []);
    assert.deepEqual(Object.keys(body.oneLiners), ["windowsInstall", "windowsCheck", "windowsUninstall", "macInstall", "macCheck", "macUninstall"]);
    assert.ok(body.oneLiners.windowsInstall.endsWith("-Release abc1234"));
    assert.ok(body.oneLiners.macUninstall.endsWith("--release abc1234 --uninstall"));

    process.env.VERCEL_GIT_COMMIT_SHA = "ABC1234";
    assert.equal((await list(state, ownerHeaders(), "?view=collector")).body.release, "0000000");
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    const unknown = await list(state, ownerHeaders(), "?view=collector");
    assert.equal(unknown.body.release, "0000000");
    assert.ok(unknown.body.oneLiners.windowsInstall.endsWith("-Release 0000000"));
  } finally {
    if (previous === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA;
    else process.env.VERCEL_GIT_COMMIT_SHA = previous;
  }
});

// ── ① 지금 확인(spec-manual §6·§10.4, 2026-10-23 재구현) ───────────────────────

const MANUAL_CLAIM_ID = "5a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const MANUAL_TOKEN = `mcm1_${"Ab3_-".repeat(8)}xyz`;
const MANUAL_SETTINGS = Object.freeze({
  manual_enabled: true, manual_min_gap_seconds: 180, manual_max_per_day: 30, manual_from_hour: 9, manual_to_hour: 19,
  manual_last_claim_at: null, manual_last_search_at: null, manual_stopped_day: null, manual_stopped_at: null,
  manual_stopped_run_id: null, manual_stopped_code: null, last_housekeeping_at: "2026-10-17T02:00:00.000Z",
});

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function manualSummary(overrides = {}) {
  return {
    state: "ready", enabled: true, usedToday: 2, maxPerDay: 30, minGapSeconds: 180, fromHour: 9, toHour: 19,
    nextAt: null, busyUntil: null, lastSearchAt: "2026-10-17T02:40:00.000Z", stoppedDay: null, stoppedAt: null,
    stoppedCode: null, cooldownUntil: null, serverTime: NOW, ...overrides,
  };
}

function manualState({ settings = {}, claimRow = { id: MANUAL_CLAIM_ID, keyword_key: "아이폰 필름", status: "verified" } } = {}) {
  const state = createState({ settings: { ...MANUAL_SETTINGS, ...settings } });
  state.tables.coupang_rank_manual_claims = claimRow ? [claimRow] : [];
  state.rpc.coupang_rank_manual_summary = () => ({ data: manualSummary(), error: null });
  state.rpc.coupang_rank_housekeeping = () => ({ data: { runs: 0 }, error: null });
  state.rpc.coupang_rank_manual_claim = () => ({
    data: {
      ok: true, claimId: MANUAL_CLAIM_ID, keyword: "아이폰 필름", keywordKey: "아이폰 필름",
      expiresAt: "2026-10-17T03:01:00.000Z", serverTime: NOW, manual: manualSummary({ state: "busy", busyUntil: "2026-10-17T03:01:00.000Z" }),
    },
    error: null,
  });
  state.rpc.coupang_rank_manual_verify = () => ({
    data: {
      ok: true, verified: true, claimId: MANUAL_CLAIM_ID, keyword: "아이폰 필름", keywordKey: "아이폰 필름",
      verifiedAt: NOW, recordUntil: "2026-10-17T03:10:00.000Z", serverTime: NOW,
    },
    error: null,
  });
  state.rpc.coupang_rank_manual_record = (args) => ({
    data: {
      ok: true, accepted: args.p_outcome === "measured", duplicate: false, status: args.p_status, errorCode: args.p_run?.errorCode ?? null,
      matched: 2, counted: true, stopped: args.p_stop_code !== null, stopCode: args.p_stop_code, late: false,
      tracker: { trackerId: uuid(1), result: "found", rank: 12, organicCount: 50, adOrder: null, checkedAt: NOW },
      manual: manualSummary({ state: args.p_stop_code ? "stopped" : "gap" }),
    },
    error: null,
  });
  state.rpc.coupang_rank_manual_stop = (args) => ({
    data: { ok: true, stopped: true, stoppedDay: "2026-10-17", stopCode: args.p_code, manual: manualSummary({ state: "stopped" }) },
    error: null,
  });
  return state;
}

function manualPage(overrides = {}) {
  return {
    status: "ok", httpStatus: 200, loginWall: true, stable: true, noResultText: false, blockedText: false, itemCount: 52,
    organic: [{ p: "9000001", v: "", s: 3 }, { p: "8533720933", v: "96009802650", s: 14, t: "아이쉘 필름" }],
    ads: [{ p: "7000001", v: "", s: 1 }],
    finalHost: "www.coupang.com", finalPath: "/np/search", errorCode: null, query: "아이폰 필름", ...overrides,
  };
}

function manualRecordBody(overrides = {}, pageOverrides = {}) {
  return {
    action: "manual-record", claimId: MANUAL_CLAIM_ID, claimToken: MANUAL_TOKEN, outcome: "measured",
    page: manualPage(pageOverrides), durationMs: 14231, extensionVersion: "1.0.0", browser: "chrome 141", ...overrides,
  };
}

function rpcArgs(state, name) {
  return state.rpcCalls.filter((entry) => entry.name === name).map((entry) => entry.args);
}

function manualGet(state, headers, view, { claimId = MANUAL_CLAIM_ID, token = MANUAL_TOKEN, reason, extraQuery = "" } = {}) {
  const query = `?view=${view}&claimId=${claimId}${reason ? `&reason=${reason}` : ""}${extraQuery}`;
  const allHeaders = token === null ? headers : { ...headers, [MANUAL_CLAIM_TOKEN_HEADER]: token };
  return call(state, "GET", { query, headers: allHeaders });
}

async function captureLogs(fn) {
  const lines = [];
  const original = { error: console.error, warn: console.warn, log: console.log };
  console.error = (line) => lines.push(String(line));
  console.warn = (line) => lines.push(String(line));
  console.log = (line) => lines.push(String(line));
  try {
    return { result: await fn(), lines };
  } finally {
    Object.assign(console, original);
  }
}

test("manual-claim: 세션 없음 401·체험 403, 운영팀·광고주는 공개 여부와 상관없이 403(RPC 0회)", async () => {
  const state = manualState();
  state.tables.coupang_rank_trackers.push(trackerRow({ id: uuid(1) }));
  const body = { action: "manual-claim", trackerId: uuid(1) };
  assert.equal((await post(state, {}, body)).status, 401);
  assert.equal((await post(state, { "x-mi-session-role": "client", "x-mi-session-scope": "trial" }, body)).body.code, "TRIAL_LOCKED");
  assert.equal((await post(state, teamHeaders("adv-a"), body)).body.code, "COUPANG_OWNER_ONLY");
  assert.equal((await post(state, teamHeaders("team-a", { accountOnly: true }), body)).body.code, "COUPANG_OWNER_ONLY");
  assert.equal((await post(state, clientHeaders("adv-a"), body)).body.code, "COUPANG_READ_ONLY");
  const closed = manualState({ settings: { team_access_enabled: false, client_view_enabled: false } });
  assert.equal((await post(closed, teamHeaders("adv-a"), body)).body.code, "COUPANG_TEAM_NOT_OPEN");
  assert.equal((await post(closed, clientHeaders("adv-a"), body)).body.code, "COUPANG_CLIENT_NOT_OPEN");
  for (const current of [state, closed]) {
    assert.equal(current.rpcCalls.filter((entry) => entry.name.startsWith("coupang_rank_manual_")).length, 0);
  }
  for (const headers of [teamHeaders("adv-a"), clientHeaders("adv-a")]) {
    assert.equal((await post(state, headers, manualRecordBody())).status, 403);
  }
});

test("manual-claim: 총관리자 → RPC 인자(범위 agency·owner·owner·원문 아닌 64자 해시), 응답 토큰 패턴·manual 칸·기한 60초", async () => {
  const state = manualState();
  const { status, body } = await post(state, ownerHeaders("adv-a"), { action: "manual-claim", trackerId: uuid(7).toUpperCase() });
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body), ["ok", "claimId", "claimToken", "keyword", "keywordKey", "expiresAt", "expiresInSeconds", "serverTime", "manual"]);
  assert.match(body.claimToken, MANUAL_TOKEN_PATTERN);
  assert.equal(body.expiresInSeconds, 60);
  assert.equal(body.manual.state, "busy");
  assert.equal(body.manual.extensionId, MANUAL_EXTENSION_ID);
  assert.equal(body.manual.extensionZipPath, MANUAL_EXTENSION_ZIP_PATH);
  const [args] = rpcArgs(state, "coupang_rank_manual_claim");
  assert.deepEqual(args, {
    p_tracker_id: uuid(7), p_agency_code: "adv-a", p_requested_by: "owner", p_requested_role: "owner",
    p_token_sha256: sha256(body.claimToken),
  });
  assert.match(args.p_token_sha256, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(state.rpcCalls).includes(body.claimToken), false, "원문 토큰은 DB 로 가지 않는다");
  // 대표 코드 범위
  const own = manualState();
  await post(own, ownerHeaders(), { action: "manual-claim", trackerId: uuid(7) });
  assert.equal(rpcArgs(own, "coupang_rank_manual_claim")[0].p_agency_code, PRIMARY);
  // 추적기 id 형식
  const bad = await post(own, ownerHeaders(), { action: "manual-claim", trackerId: "x" });
  assert.deepEqual([bad.status, bad.body.code], [404, "COUPANG_TRACKER_NOT_FOUND"]);
});

test("manual-claim: 수동 칸 없는 설정 → 409 MANUAL_SETUP_REQUIRED(RPC 0회), RPC 없음(PGRST202) → 409(503 아님), C 표 없음 → 503", async () => {
  const before = createState();
  const noColumns = await post(before, ownerHeaders(), { action: "manual-claim", trackerId: uuid(1) });
  assert.deepEqual([noColumns.status, noColumns.body.code], [409, "COUPANG_MANUAL_SETUP_REQUIRED"]);
  assert.equal(before.rpcCalls.length, 0);
  const noFunction = manualState();
  delete noFunction.rpc.coupang_rank_manual_claim;
  const missing = await post(noFunction, ownerHeaders(), { action: "manual-claim", trackerId: uuid(1) });
  assert.deepEqual([missing.status, missing.body.code], [409, "COUPANG_MANUAL_SETUP_REQUIRED"]);
  const noTables = manualState();
  delete noTables.tables.coupang_rank_settings;
  const tables = await post(noTables, ownerHeaders(), { action: "manual-claim", trackerId: uuid(1) });
  assert.deepEqual([tables.status, tables.body.code], [503, "COUPANG_SETUP_REQUIRED"]);
});

test("manual-claim: 상태 거절 9개 → 코드·HTTP·사유별 문구·manual, gap·busy 는 retryAfterSec(서버 시계끼리)", async () => {
  const expected = {
    off: ["COUPANG_MANUAL_OFF", 403], budget: ["COUPANG_MANUAL_BUDGET", 409], stopped: ["COUPANG_MANUAL_STOPPED", 409],
    cooldown: ["COUPANG_MANUAL_COOLDOWN", 409], hours: ["COUPANG_MANUAL_HOURS", 409], busy: ["COUPANG_MANUAL_BUSY", 409],
    daily_cap: ["COUPANG_MANUAL_DAILY_CAP", 409], gap: ["COUPANG_MANUAL_GAP", 409], setup_required: ["COUPANG_MANUAL_SETUP_REQUIRED", 409],
  };
  for (const [stateName, [code, status]] of Object.entries(expected)) {
    const state = manualState();
    const summary = manualSummary({
      state: stateName,
      nextAt: stateName === "gap" ? "2026-10-17T03:02:30.000Z" : null,
      busyUntil: stateName === "busy" ? "2026-10-17T03:00:45.000Z" : null,
    });
    state.rpc.coupang_rank_manual_claim = () => ({ data: { ok: false, state: stateName, manual: summary }, error: null });
    const result = await post(state, ownerHeaders(), { action: "manual-claim", trackerId: uuid(1) });
    assert.deepEqual([result.status, result.body.code, result.body.ok], [status, code, false], stateName);
    assert.ok(result.body.message, stateName);
    if (stateName !== "setup_required") assert.equal(result.body.manual.state, stateName);
    if (stateName === "gap") {
      assert.equal(result.body.retryAfterSec, 150);
      assert.equal(result.body.nextAt, "2026-10-17T03:02:30.000Z");
      assert.equal(result.body.message, "검색과 검색 사이 간격(3분)을 기다리는 중입니다.");
    }
    if (stateName === "busy") assert.equal(result.body.retryAfterSec, 45);
    if (stateName === "hours") assert.equal(result.body.message, "지금 확인은 9~19시(한국 시각)에만 됩니다.");
  }
  for (const [code, status] of [["COUPANG_TRACKER_NOT_FOUND", 404], ["COUPANG_MANUAL_TRACKER_PAUSED", 409], ["COUPANG_MANUAL_TRACKER_INELIGIBLE", 409], ["COUPANG_ACTION_INVALID", 400]]) {
    const state = manualState();
    state.rpc.coupang_rank_manual_claim = () => ({ data: { ok: false, code }, error: null });
    const result = await post(state, ownerHeaders(), { action: "manual-claim", trackerId: uuid(1) });
    assert.deepEqual([result.status, result.body.code], [status, code]);
    assert.ok(result.body.message);
  }
});

test("manual-claim: 보관 정리는 마지막 정리가 6시간 넘었을 때만, 실패해도 요청은 진행", async () => {
  const stale = manualState({ settings: { last_housekeeping_at: "2026-10-16T20:00:00.000Z" } });
  await post(stale, ownerHeaders(), { action: "manual-claim", trackerId: uuid(1) });
  assert.equal(rpcArgs(stale, "coupang_rank_housekeeping").length, 1);
  const fresh = manualState({ settings: { last_housekeeping_at: "2026-10-17T02:00:00.000Z" } });
  await post(fresh, ownerHeaders(), { action: "manual-claim", trackerId: uuid(1) });
  assert.equal(rpcArgs(fresh, "coupang_rank_housekeeping").length, 0);
  const never = manualState({ settings: { last_housekeeping_at: null } });
  never.rpc.coupang_rank_housekeeping = () => ({ data: null, error: { code: "57014", message: "secret detail" } });
  const { result, lines } = await captureLogs(() => post(never, ownerHeaders(), { action: "manual-claim", trackerId: uuid(1) }));
  assert.equal(result.status, 200);
  assert.equal(rpcArgs(never, "coupang_rank_housekeeping").length, 1);
  assert.equal(JSON.parse(lines[0]).event, "coupang_rank_trackers_housekeeping_failed");
  assert.equal(lines.join("\n").includes("secret"), false);
});

test("manual-record: 본문 상한 — manual-record 만 64KB, 다른 동작은 33KB 도 413, 64KB 넘음 413", async () => {
  const state = manualState();
  const pad = "가".repeat(13000); // 약 39KB
  const big = await post(state, ownerHeaders(), manualRecordBody({ pad }));
  assert.equal(big.status, 200, JSON.stringify(big.body));
  const other = await post(state, ownerHeaders(), { action: "manual-claim", trackerId: uuid(1), pad });
  assert.deepEqual([other.status, other.body.code], [413, "BODY_TOO_LARGE"]);
  const declared = await call(state, "POST", { headers: { ...ownerHeaders(), "content-length": "40000" }, body: { action: "pause", ids: [uuid(1)] } });
  assert.equal(declared.status, 413);
  const declaredManual = await call(state, "POST", { headers: { ...ownerHeaders(), "content-length": "40000" }, body: manualRecordBody() });
  assert.equal(declaredManual.status, 200);
  const huge = await post(state, ownerHeaders(), manualRecordBody({ pad: "가".repeat(23000) }));
  assert.deepEqual([huge.status, huge.body.code], [413, "BODY_TOO_LARGE"]);
});

test("manual-record: 형식 오류 400 {field}(RPC 0회), 모양이 틀려도 차단 신호가 보이면 그날 중지만 건다", async () => {
  const state = manualState();
  for (const [overrides, field] of [
    [{ claimId: "x" }, "claimId"], [{ claimToken: "mic1_x" }, "claimToken"], [{ outcome: "done" }, "outcome"],
    [{ outcomeCode: "Bad Code" }, "outcomeCode"], [{ outcomeCode: 3 }, "outcomeCode"],
    [{ extensionVersion: "1.0" }, "extensionVersion"], [{ durationMs: -1 }, "durationMs"],
  ]) {
    const result = await post(state, ownerHeaders(), manualRecordBody(overrides));
    assert.deepEqual([result.status, result.body.code, result.body.field], [400, "COUPANG_MANUAL_RECORD_INVALID", field], JSON.stringify(overrides));
  }
  const badQuery = await post(state, ownerHeaders(), manualRecordBody({}, { query: "가".repeat(101) }));
  assert.equal(badQuery.body.field, "page.query");
  assert.equal(state.rpcCalls.length, 0);

  const blockedButBroken = await post(state, ownerHeaders(), manualRecordBody({}, { httpStatus: 403, organic: "broken" }));
  assert.deepEqual([blockedButBroken.status, blockedButBroken.body.field, blockedButBroken.body.stopped, blockedButBroken.body.stopCode],
    [400, "page.organic", true, "blocked_http_403"]);
  assert.equal(blockedButBroken.body.manual.state, "stopped");
  assert.deepEqual(rpcArgs(state, "coupang_rank_manual_stop"), [{
    p_claim_id: MANUAL_CLAIM_ID, p_token_sha256: sha256(MANUAL_TOKEN), p_requested_by: "owner", p_code: "blocked_http_403", p_run_id: null,
  }]);
  assert.equal(rpcArgs(state, "coupang_rank_manual_record").length, 0);
});

test("manual-record: 서버 판정을 RPC 로 넘긴다 — 403·page_unreadable 은 차단+중지 사유, 검색어 다름은 error(query_mismatch), 광고만은 empty", async () => {
  const cases = [
    [{}, "ok", null, null],
    [{ httpStatus: 403, status: "blocked", organic: [], ads: [], itemCount: 0 }, "blocked", "blocked_http_403", null],
    [{ httpStatus: 200, blockedText: true, organic: [], ads: [], itemCount: 0 }, "blocked", "blocked_text", null],
    [{ status: "error", errorCode: "page_unreadable", finalHost: "", finalPath: "", httpStatus: null, organic: [], ads: [], itemCount: 0, query: "" }, "blocked", "page_unreadable", "page_unreadable"],
    [{ query: "아이폰 케이스" }, "error", null, "query_mismatch"],
    [{ query: "아이폰  필름" }, "ok", null, null],
    [{ organic: [], ads: [{ p: "7000001", v: "", s: 1 }], itemCount: 1 }, "empty", null, null],
    [{ finalPath: "/vp/products/1", errorCode: "user_navigated" }, "error", null, "user_navigated"],
    [{ finalPath: "/np/campaigns/9" }, "unsupported", null, null],
    [{ status: "error", errorCode: "window_closed", httpStatus: null }, "error", null, "window_closed"],
  ];
  for (const [pageOverrides, status, stopCode, errorCode] of cases) {
    const state = manualState();
    const result = await post(state, ownerHeaders(), manualRecordBody({}, pageOverrides));
    assert.equal(result.status, 200, JSON.stringify(pageOverrides));
    const [args] = rpcArgs(state, "coupang_rank_manual_record");
    assert.equal(args.p_status, status, JSON.stringify(pageOverrides));
    assert.equal(args.p_stop_code, stopCode, JSON.stringify(pageOverrides));
    assert.equal(args.p_run.errorCode, errorCode, JSON.stringify(pageOverrides));
    assert.deepEqual([args.p_claim_id, args.p_token_sha256, args.p_requested_by, args.p_outcome, args.p_outcome_code],
      [MANUAL_CLAIM_ID, sha256(MANUAL_TOKEN), "owner", "measured", null]);
    assert.equal(args.p_run.collectorVersion, "1.0.0");
    assert.equal(Object.hasOwn(args.p_run, "query"), false, "p_run 은 수집기와 같은 칸만");
  }
  // 시작 못 함·응답 없음: p_status·p_run 은 null, blocked_today 만 중지 사유
  for (const [outcome, outcomeCode, stopCode] of [
    ["not_started", "incognito_window_open", null], ["not_started", "blocked_today", "extension_reported"],
    ["not_started", "report_pending", "extension_reported"], ["lost", "extension_timeout", null],
  ]) {
    const state = manualState();
    const body = { action: "manual-record", claimId: MANUAL_CLAIM_ID, claimToken: MANUAL_TOKEN, outcome, outcomeCode };
    const result = await post(state, ownerHeaders(), body);
    assert.equal(result.status, 200);
    const [args] = rpcArgs(state, "coupang_rank_manual_record");
    assert.deepEqual([args.p_status, args.p_run, args.p_stop_code, args.p_outcome_code], [null, null, stopCode, outcomeCode]);
  }
});

test("manual-record: 요청 없음 404·표 없음 409, RPC 거절 코드 → HTTP(늦음 410 + stopped), 200 응답 모양", async () => {
  const none = manualState({ claimRow: null });
  assert.deepEqual([(await post(none, ownerHeaders(), manualRecordBody())).status, rpcArgs(none, "coupang_rank_manual_record").length], [404, 0]);
  const noTable = manualState();
  delete noTable.tables.coupang_rank_manual_claims;
  assert.equal((await post(noTable, ownerHeaders(), manualRecordBody())).body.code, "COUPANG_MANUAL_SETUP_REQUIRED");
  for (const [code, status, extra] of [
    ["COUPANG_MANUAL_CLAIM_EXPIRED", 410, { stopped: true }], ["COUPANG_MANUAL_CLAIM_NOT_VERIFIED", 409, { stopped: false }],
    ["COUPANG_MANUAL_CLAIM_MISMATCH", 409, {}], ["COUPANG_MANUAL_CLAIM_CLOSED", 409, { stopped: true }],
    ["COUPANG_MANUAL_RECORD_INVALID", 400, { field: "timing" }], ["COUPANG_MANUAL_CLAIM_NOT_FOUND", 404, {}],
  ]) {
    const state = manualState();
    state.rpc.coupang_rank_manual_record = () => ({ data: { ok: false, code, ...extra }, error: null });
    const result = await post(state, ownerHeaders(), manualRecordBody());
    assert.deepEqual([result.status, result.body.code], [status, code]);
    for (const [key, value] of Object.entries(extra)) assert.equal(result.body[key], value, `${code}.${key}`);
  }
  const missingFn = manualState();
  delete missingFn.rpc.coupang_rank_manual_record;
  assert.deepEqual([(await post(missingFn, ownerHeaders(), manualRecordBody())).status], [409]);
  const ok = await post(manualState(), ownerHeaders(), manualRecordBody({}, { httpStatus: 403, status: "blocked", organic: [], ads: [], itemCount: 0 }));
  assert.deepEqual(Object.keys(ok.body), [
    "ok", "accepted", "duplicate", "outcome", "status", "errorCode", "matched", "counted", "stopped", "stopCode", "late", "tracker", "manual",
  ]);
  assert.deepEqual([ok.body.accepted, ok.body.status, ok.body.stopped, ok.body.stopCode, ok.body.manual.state], [true, "blocked", true, "blocked_http_403", "stopped"]);
  assert.equal(ok.body.tracker.rank, 12);
});

test("GET ?view=manual-verify: 같은 크롬 세션 + 머리글 토큰 → 서버 확인, 응답은 서버가 정한 검색어, 토큰은 주소로 받지 않는다", async () => {
  const state = manualState();
  const { status, body, headers } = await manualGet(state, ownerHeaders(), "manual-verify", { claimId: MANUAL_CLAIM_ID.toUpperCase() });
  assert.equal(status, 200);
  assert.equal(headers.get("cache-control"), "no-store");
  assert.deepEqual(body, {
    ok: true, verified: true, claimId: MANUAL_CLAIM_ID, keyword: "아이폰 필름", keywordKey: "아이폰 필름",
    verifiedAt: NOW, recordUntil: "2026-10-17T03:10:00.000Z", serverTime: NOW,
  });
  assert.deepEqual(rpcArgs(state, "coupang_rank_manual_verify"), [{
    p_claim_id: MANUAL_CLAIM_ID, p_token_sha256: sha256(MANUAL_TOKEN), p_requested_by: "owner",
  }]);
  // 토큰 머리글 없음(주소에 실어도) → 400, RPC 0회
  const urlToken = await manualGet(state, ownerHeaders(), "manual-verify", { token: null, extraQuery: `&claimToken=${MANUAL_TOKEN}` });
  assert.deepEqual([urlToken.status, urlToken.body.code, urlToken.body.field], [400, "COUPANG_ACTION_INVALID", "claimToken"]);
  const badId = await manualGet(state, ownerHeaders(), "manual-verify", { claimId: "nope" });
  assert.equal(badId.body.field, "claimId");
  assert.equal(rpcArgs(state, "coupang_rank_manual_verify").length, 1);
  // 운영팀·광고주·세션 없음
  assert.equal((await manualGet(state, teamHeaders("adv-a"), "manual-verify")).body.code, "COUPANG_OWNER_ONLY");
  assert.equal((await manualGet(state, clientHeaders("adv-a"), "manual-verify")).body.code, "COUPANG_OWNER_ONLY");
  assert.equal((await manualGet(state, {}, "manual-verify")).status, 401);
  assert.equal(rpcArgs(state, "coupang_rank_manual_verify").length, 1);
});

test("GET ?view=manual-verify: 거절은 ok:false(성공 모양 아님) — 상태·1회용·기한·설정 없음·표 없음", async () => {
  for (const [data, status, code] of [
    [{ ok: false, state: "gap", manual: manualSummary({ state: "gap", nextAt: "2026-10-17T03:01:40.000Z" }) }, 409, "COUPANG_MANUAL_GAP"],
    [{ ok: false, state: "stopped", manual: manualSummary({ state: "stopped" }) }, 409, "COUPANG_MANUAL_STOPPED"],
    [{ ok: false, code: "COUPANG_MANUAL_CLAIM_USED" }, 409, "COUPANG_MANUAL_CLAIM_USED"],
    [{ ok: false, code: "COUPANG_MANUAL_CLAIM_EXPIRED" }, 410, "COUPANG_MANUAL_CLAIM_EXPIRED"],
    [{ ok: false, code: "COUPANG_MANUAL_CLAIM_MISMATCH" }, 409, "COUPANG_MANUAL_CLAIM_MISMATCH"],
    [{ ok: true }, 409, "COUPANG_MANUAL_SETUP_REQUIRED"],
  ]) {
    const state = manualState();
    state.rpc.coupang_rank_manual_verify = () => ({ data, error: null });
    const result = await manualGet(state, ownerHeaders(), "manual-verify");
    assert.deepEqual([result.status, result.body.ok, result.body.code, result.body.verified], [status, false, code, undefined], code);
  }
  const noColumns = createState();
  const before = await manualGet(noColumns, ownerHeaders(), "manual-verify");
  assert.deepEqual([before.status, before.body.ok, before.body.code], [409, false, "COUPANG_MANUAL_SETUP_REQUIRED"]);
  const noTables = manualState();
  delete noTables.tables.coupang_rank_settings;
  const tables = await manualGet(noTables, ownerHeaders(), "manual-verify");
  assert.deepEqual([tables.status, tables.body.ok, tables.body.code], [503, false, "COUPANG_SETUP_REQUIRED"]);
  const noFunction = manualState();
  delete noFunction.rpc.coupang_rank_manual_verify;
  assert.deepEqual([(await manualGet(noFunction, ownerHeaders(), "manual-verify")).status], [409]);
});

test("GET ?view=manual-stop: 사유는 계약 목록만, 토큰 해시·회차 없음으로 중지 RPC, 응답 stopped·manual", async () => {
  const state = manualState();
  const ok = await manualGet(state, ownerHeaders(), "manual-stop", { reason: "blocked_http_403" });
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.body.ok, ok.body.stopped, ok.body.stoppedDay, ok.body.stopCode, ok.body.manual.state], [true, true, "2026-10-17", "blocked_http_403", "stopped"]);
  assert.deepEqual(rpcArgs(state, "coupang_rank_manual_stop"), [{
    p_claim_id: MANUAL_CLAIM_ID, p_token_sha256: sha256(MANUAL_TOKEN), p_requested_by: "owner", p_code: "blocked_http_403", p_run_id: null,
  }]);
  for (const reason of ["", "blocked", "drop table", "BLOCKED_TEXT"]) {
    const bad = await manualGet(state, ownerHeaders(), "manual-stop", { reason: reason || undefined });
    assert.deepEqual([bad.status, bad.body.field], [400, "reason"], reason);
  }
  assert.equal(rpcArgs(state, "coupang_rank_manual_stop").length, 1);
  state.rpc.coupang_rank_manual_stop = () => ({ data: { ok: false, code: "COUPANG_MANUAL_CLAIM_MISMATCH" }, error: null });
  assert.equal((await manualGet(state, ownerHeaders(), "manual-stop", { reason: "page_unreadable" })).status, 409);
  assert.equal((await manualGet(state, teamHeaders("adv-a"), "manual-stop", { reason: "page_unreadable" })).body.code, "COUPANG_OWNER_ONLY");
});

test("GET 목록: manual 칸은 총관리자에게만(확장 ID·zip 경로 포함), 운영팀·광고주 응답에는 키 자체가 없다, 요약 실패는 setup_required(200)", async () => {
  const state = manualState();
  state.tables.coupang_rank_trackers.push(trackerRow());
  const owner = await list(state, ownerHeaders());
  assert.equal(owner.status, 200);
  assert.equal(owner.body.manual.state, "ready");
  assert.equal(owner.body.manual.usedToday, 2);
  assert.equal(owner.body.manual.extensionId, MANUAL_EXTENSION_ID);
  assert.equal(owner.body.manual.extensionZipPath, MANUAL_EXTENSION_ZIP_PATH);
  assert.deepEqual(rpcArgs(state, "coupang_rank_manual_summary"), [{ p_exclude_claim: null }]);
  const teamState = manualState();
  teamState.tables.coupang_rank_trackers.push(trackerRow({ agency_code: "adv-a", client_id: CLIENT_A }));
  for (const headers of [teamHeaders("adv-a"), clientHeaders("adv-a")]) {
    const result = await list(teamState, headers);
    assert.equal(result.status, 200);
    assert.equal(Object.hasOwn(result.body, "manual"), false);
  }
  assert.equal(rpcArgs(teamState, "coupang_rank_manual_summary").length, 0);
  const missing = manualState();
  delete missing.rpc.coupang_rank_manual_summary;
  assert.deepEqual((await list(missing, ownerHeaders())).body.manual, { state: "setup_required" });
  const broken = manualState();
  broken.rpc.coupang_rank_manual_summary = () => ({ data: null, error: { code: "57014", message: "secret detail" } });
  const { result, lines } = await captureLogs(() => list(broken, ownerHeaders()));
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.manual, { state: "setup_required" });
  assert.equal(JSON.parse(lines[0]).event, "coupang_rank_trackers_manual_summary_failed");
  assert.equal(lines.join("\n").includes("secret"), false);
});

test("settings-update manualEnabled: 총관리자 켜기·끄기는 바로 저장(상향 아님), 수동 칸 없으면 409, 운영팀은 OWNER_ONLY", async () => {
  const state = manualState({ settings: { manual_enabled: false } });
  const on = await post(state, ownerHeaders(), { action: "settings-update", settings: { manualEnabled: true } });
  assert.equal(on.status, 200);
  assert.equal(on.body.settings.manualEnabled, true);
  assert.equal(state.tables.coupang_rank_settings[0].manual_enabled, true);
  assert.equal(state.rpcCalls.filter((entry) => entry.name === "coupang_rank_stats").length, 0);
  const off = await post(state, ownerHeaders(), { action: "settings-update", settings: { manualEnabled: false } });
  assert.equal(off.body.settings.manualEnabled, false);
  const before = createState();
  const refused = await post(before, ownerHeaders(), { action: "settings-update", settings: { manualEnabled: true } });
  assert.deepEqual([refused.status, refused.body.code], [409, "COUPANG_MANUAL_SETUP_REQUIRED"]);
  assert.equal(Object.hasOwn(before.tables.coupang_rank_settings[0], "manual_enabled"), false);
  assert.equal((await post(state, teamHeaders("adv-a"), { action: "settings-update", settings: { manualEnabled: true } })).body.code, "COUPANG_OWNER_ONLY");
  for (const value of ["true", 1]) {
    assert.equal((await post(state, ownerHeaders(), { action: "settings-update", settings: { manualEnabled: value } })).body.field, "manualEnabled");
  }
});

// 2026-10-23 검토(지난 #5 그대로): 자동 claim(C 원문)은 수동 간격·그날 중지를 보지 않는다. 고치기 전까지 둘이 함께 켜지지 않게 한다.
test("지금 확인 ↔ 자동 수집: 지금 확인이 켜져 있거나 오늘 지금 확인이 차단으로 멈춘 날에는 '수집 켜기' 409, 자동이 켜져 있으면 '지금 확인 켜기' 409, 끄기는 언제나", async () => {
  const collector = { id: uuid(510), revoked_at: null, token_sha256: "c".repeat(64) };
  const manualOn = manualState({ settings: { manual_enabled: true } });
  manualOn.tables.coupang_rank_collectors.push({ ...collector });
  const refusedOn = await post(manualOn, ownerHeaders(), { action: "collector-enable" });
  assert.deepEqual([refusedOn.status, refusedOn.body.code, refusedOn.body.reason], [409, "COUPANG_COLLECTOR_MANUAL_CONFLICT", "manual_enabled"]);
  assert.match(refusedOn.body.message, /지금 확인 끄기/u);
  assert.equal(manualOn.tables.coupang_rank_settings[0].enabled, false, "자동 수집은 그대로 꺼져 있다");

  const stoppedToday = manualState({ settings: { manual_enabled: false, manual_stopped_day: "2026-10-17", manual_stopped_code: "blocked_http_403" } });
  stoppedToday.tables.coupang_rank_collectors.push({ ...collector });
  const refusedStopped = await post(stoppedToday, ownerHeaders(), { action: "collector-enable" });
  assert.deepEqual([refusedStopped.status, refusedStopped.body.code, refusedStopped.body.reason], [409, "COUPANG_COLLECTOR_MANUAL_CONFLICT", "manual_stopped_today"]);
  assert.equal(stoppedToday.tables.coupang_rank_settings[0].enabled, false);

  // 지금 확인을 끄고 그날 중지가 어제였다면 켜진다. 끄기는 언제나 된다.
  const yesterday = manualState({ settings: { manual_enabled: false, manual_stopped_day: "2026-10-16" } });
  yesterday.tables.coupang_rank_collectors.push({ ...collector });
  const enabled = await post(yesterday, ownerHeaders(), { action: "collector-enable" });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.settings.enabled, true);
  // 자동이 켜져 있으면 지금 확인 켜기를 거절, 끄기·다른 설정은 된다
  const manualRefused = await post(yesterday, ownerHeaders(), { action: "settings-update", settings: { manualEnabled: true } });
  assert.deepEqual([manualRefused.status, manualRefused.body.code, manualRefused.body.reason], [409, "COUPANG_MANUAL_COLLECTOR_CONFLICT", "collector_enabled"]);
  assert.equal(yesterday.tables.coupang_rank_settings[0].manual_enabled, false);
  assert.equal((await post(yesterday, ownerHeaders(), { action: "settings-update", settings: { manualEnabled: false } })).status, 200);
  const disabled = await post(manualOn, ownerHeaders(), { action: "collector-disable" });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.body.settings.enabled, false);
  // 수동 칸이 없는 설정(대표 SQL 전)은 예전 그대로
  const before = createState();
  before.tables.coupang_rank_collectors.push({ ...collector });
  assert.equal((await post(before, ownerHeaders(), { action: "collector-enable" })).status, 200);
});

// 2026-10-23 검토: 수동 '지금 확인' 성공이 자동 집계(coupang_rank_stats)에 섞여 수집기 0대로도 속도 올리기 관문이 열렸다.
test("속도 올리기 관문·수집기 관리 '마지막 성공'·목록 '최근 갱신(수집기 PC)'은 수집기 회차만 센다(수동 성공 48번으로는 안 열림)", async () => {
  const manualRuns = (count) => Array.from({ length: count }, (_, index) => ({
    id: uuid(7000 + index), keyword_key: "아이폰 필름", status: "ok", source: "manual",
    claimed_at: new Date(Date.parse(NOW) - (index + 1) * 60_000).toISOString(),
  }));
  const state = manualState({ settings: { manual_enabled: true } });
  state.tables.coupang_rank_runs.push(...manualRuns(48));
  // C 원문 집계는 출처를 가리지 않아 48(이상)로 센다
  state.stats = { blocked48h: 0, empty48h: 0, success48h: 48, activeKeywords: 1, ineligibleActiveTrackers: 0, lastSuccessAt: state.tables.coupang_rank_runs[0].claimed_at };
  const raise = await post(state, ownerHeaders(), { action: "settings-update", settings: { maxRunsPerHour: 24 }, confirmRaise: true });
  assert.deepEqual([raise.status, raise.body.code], [409, "COUPANG_RAISE_NOT_ALLOWED"]);
  assert.deepEqual(raise.body.reasons, ["too_few_success_48h"]);
  assert.equal(raise.body.success48h, 0);
  assert.equal(state.tables.coupang_rank_settings[0].max_runs_per_hour, 12);
  const panel = await list(state, ownerHeaders(), "?view=collector");
  assert.equal(panel.status, 200);
  assert.equal(panel.body.stats.success48h, 0);
  assert.equal(panel.body.stats.successSource, "collector");
  assert.equal(panel.body.stats.lastSuccessAt, null);
  assert.equal(panel.body.raise.allowed, false);
  const listed = await list(state, ownerHeaders());
  assert.equal(listed.body.collector.lastSuccessAt, null, "수동 확인만 있으면 '최근 갱신(수집기 PC)'은 비어 있다");

  // 48시간 안의 수집기 성공 48번이면 열린다(48시간보다 오래된 회차·수동 회차는 세지 않음)
  const collectorRuns = Array.from({ length: 48 }, (_, index) => ({
    id: uuid(8000 + index), keyword_key: "아이폰 필름", status: index % 2 ? "ok" : "noresult", source: "collector",
    claimed_at: new Date(Date.parse(NOW) - (index + 1) * 3_600_000 * 0.9).toISOString(),
  }));
  const ready = manualState({ settings: { manual_enabled: false } });
  ready.tables.coupang_rank_runs.push(...manualRuns(10), ...collectorRuns, {
    id: uuid(8999), keyword_key: "아이폰 필름", status: "ok", source: "collector", claimed_at: "2026-10-14T00:00:00.000Z",
  });
  const raised = await post(ready, ownerHeaders(), { action: "settings-update", settings: { maxRunsPerHour: 24 }, confirmRaise: true });
  assert.equal(raised.status, 200, JSON.stringify(raised.body));
  assert.equal(raised.body.settings.maxRunsPerHour, 24);
  const readyPanel = await list(ready, ownerHeaders(), "?view=collector");
  assert.equal(readyPanel.body.stats.success48h, 48);
  assert.equal(readyPanel.body.stats.lastSuccessAt, collectorRuns[0].claimed_at);
  const readyList = await list(ready, ownerHeaders());
  assert.equal(readyList.body.collector.lastSuccessAt, collectorRuns[0].claimed_at);
});

test("기록 로그에 요청 토큰·요청 id·검색어가 남지 않는다(실패 500 경로 포함)", async () => {
  const state = manualState();
  state.rpc.coupang_rank_manual_record = () => ({ data: null, error: { code: "57014", message: "canceling statement" } });
  const { result, lines } = await captureLogs(() => post(state, ownerHeaders(), manualRecordBody()));
  assert.equal(result.status, 500);
  assert.equal(result.body.code, "COUPANG_RANK_TRACKERS_FAILED");
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.deepEqual([entry.event, entry.action, entry.stage, entry.errorCode], ["coupang_rank_trackers_failed", "manual-record", "manual_record", "57014"]);
  const verifyState = manualState();
  verifyState.rpc.coupang_rank_manual_verify = () => ({ data: "not-an-object", error: null });
  const verifyLogs = await captureLogs(() => manualGet(verifyState, ownerHeaders(), "manual-verify"));
  assert.equal(verifyLogs.result.status, 500);
  for (const line of [...lines, ...verifyLogs.lines]) {
    assert.equal(line.includes(MANUAL_TOKEN), false);
    assert.equal(line.includes(MANUAL_CLAIM_ID), false);
    assert.equal(line.includes(sha256(MANUAL_TOKEN)), false);
    assert.equal(line.includes("아이폰"), false);
  }
  assert.equal(HANDLER_SOURCE.includes("claimToken:"), true, "토큰은 claim 응답에만 싣는다");
  assert.equal(/console\.(?:log|warn|error)\([^)]*claim(?:Token|Id)/.test(HANDLER_SOURCE), false);
});
