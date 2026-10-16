import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { handleCoupangRankTrackersRequest } from "./coupang-rank-trackers.mjs";
import { COLLECTOR_TOKEN_PATTERN } from "../coupang-rank/contract.mjs";

const PRIMARY = "mml93-a01";
const NOW = "2026-10-17T03:00:00.000Z"; // KST 12:00(수집 시간대 안)
const CLIENT_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const CLIENT_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const CLIENT_GONE = "cccccccc-0000-4000-8000-00000000000c";
const HANDLER_SOURCE = readFileSync(new URL("./coupang-rank-trackers.mjs", import.meta.url), "utf8");

function uuid(n) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
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

  lte(column, value) {
    return this.addFilter("lte", column, value, (row) => row[column] !== null && row[column] !== undefined && row[column] <= value);
  }

  in(column, values) {
    const allowed = new Set(values);
    return this.addFilter("in", column, [...values], (row) => allowed.has(row[column]));
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
    "returnedCount", "totalCount", "hasMore", "complete", "todayKst", "days30", "limit", "collector", "trackers",
  ]);
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
