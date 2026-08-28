import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_RANK_KEYWORD_LIMIT,
  MAX_RANK_KEYWORD_LIMIT,
  isMissingRankKeywordLimitSchema,
  isRankKeywordLimitDbError,
  normalizeStoredRankKeywordLimit,
  parseRankKeywordLimitInput,
  rankKeywordLimitMessage,
  resolveRankKeywordLimit,
} from "./rank-keyword-limit.mjs";

const BOUNDS_MESSAGE = "키워드 한도는 1~1000 사이 숫자로 입력해주세요.";

// 총관리자가 콘솔에 적어 넣는 값은 문자열로 올라온다. 빈 값은 "기본값으로
// 되돌린다"는 뜻이라 오류가 아니라 null 이어야 한다.
test("키워드 한도 입력은 빈 값을 기본값 복귀로 읽고 범위를 벗어나면 막는다", () => {
  for (const blank of [null, undefined, "", "  "]) {
    assert.deepEqual(parseRankKeywordLimitInput(blank), { ok: true, limit: null });
  }
  assert.deepEqual(parseRankKeywordLimitInput("1"), { ok: true, limit: 1 });
  assert.deepEqual(parseRankKeywordLimitInput("1000"), { ok: true, limit: 1000 });
  assert.deepEqual(parseRankKeywordLimitInput(200), { ok: true, limit: 200 });

  for (const bad of ["0", "1001", "-5", "12.5", "abc", "1e3", "50 개"]) {
    assert.deepEqual(parseRankKeywordLimitInput(bad), { ok: false, message: BOUNDS_MESSAGE }, bad);
  }
});

test("저장된 한도는 숫자가 아니거나 1 미만이면 지정하지 않은 것으로 본다", () => {
  for (const empty of [null, undefined, 0, -1, "x", ""]) {
    assert.equal(normalizeStoredRankKeywordLimit(empty), null);
  }
  assert.equal(normalizeStoredRankKeywordLimit("200"), 200);
  assert.equal(normalizeStoredRankKeywordLimit(200), 200);
  // DB CHECK 는 10000 까지 허용하지만 서버가 실제로 인정하는 상한은 더 좁다.
  assert.equal(normalizeStoredRankKeywordLimit(99999), MAX_RANK_KEYWORD_LIMIT);
});

function stubCtx(responses) {
  const tables = [];
  return {
    tables,
    ctx: {
      supabaseAdmin: {
        from(table) {
          tables.push(table);
          const query = {
            select() { return query; },
            eq() { return query; },
            async maybeSingle() {
              return responses[table] || { data: null, error: null };
            },
          };
          return query;
        },
      },
    },
  };
}

test("광고주 행이 있으면 그 값이 이기고 운영팀 표는 보지 않는다", async () => {
  const stored = stubCtx({ clients: { data: { rank_keyword_limit: 200 }, error: null } });
  assert.deepEqual(await resolveRankKeywordLimit(stored.ctx, "mml93-c07"), { limit: 200, source: "client" });
  assert.deepEqual(stored.tables, ["clients"]);

  // 광고주 행은 있는데 값이 null 이면 "기본값을 쓴다"는 뜻이다. 같은 문자열의
  // 운영팀 코드가 있더라도 조용히 덮어쓰면 안 된다.
  const explicitDefault = stubCtx({
    clients: { data: { rank_keyword_limit: null }, error: null },
    operation_team_codes: { data: { rank_keyword_limit: 300 }, error: null },
  });
  assert.deepEqual(
    await resolveRankKeywordLimit(explicitDefault.ctx, "mml93-c07"),
    { limit: DEFAULT_RANK_KEYWORD_LIMIT, source: "default" },
  );
  assert.deepEqual(explicitDefault.tables, ["clients"]);
  assert.ok(!explicitDefault.tables.includes("operation_team_codes"));
});

test("광고주 미연결 운영팀 계정은 운영팀 표의 한도를 쓴다", async () => {
  const team = stubCtx({
    clients: { data: null, error: null },
    operation_team_codes: { data: { rank_keyword_limit: 300 }, error: null },
  });
  assert.deepEqual(await resolveRankKeywordLimit(team.ctx, "mml93-t02"), { limit: 300, source: "team" });
  assert.deepEqual(team.tables, ["clients", "operation_team_codes"]);

  const neither = stubCtx({});
  assert.deepEqual(
    await resolveRankKeywordLimit(neither.ctx, "mml93-t99"),
    { limit: DEFAULT_RANK_KEYWORD_LIMIT, source: "default" },
  );
});

// console.warn 을 잠깐 바꿔치기해 경고를 모은다. 단언이 실패해도 finally 로
// 반드시 되돌려서 스텁이 다른 테스트로 새지 않게 한다.
async function captureWarn(run) {
  const original = console.warn;
  const warnings = [];
  console.warn = (...args) => {
    warnings.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    const value = await run();
    return { value, warnings };
  } finally {
    console.warn = original;
  }
}

test("컬럼이 없는 DB(마이그레이션 적용 전)에서도 기본값 50 으로 조용히 내려앉는다", async () => {
  const missing = stubCtx({
    clients: { data: null, error: { code: "42703", message: "column clients.rank_keyword_limit does not exist" } },
  });
  const missingRun = await captureWarn(() => resolveRankKeywordLimit(missing.ctx, "mml93-c07"));
  assert.deepEqual(missingRun.value, { limit: DEFAULT_RANK_KEYWORD_LIMIT, source: "default" });
  // 마이그레이션 대기는 예정된 경로라 로그를 남기지 않는다.
  assert.deepEqual(missingRun.warnings, []);
  // 광고주 조회가 실패하면 운영팀 표도 보지 않고 바로 기본값이다.
  assert.deepEqual(missing.tables, ["clients"]);

  const blank = stubCtx({});
  const blankRun = await captureWarn(() => resolveRankKeywordLimit(blank.ctx, "   "));
  assert.deepEqual(blankRun.value, { limit: DEFAULT_RANK_KEYWORD_LIMIT, source: "default" });
  assert.deepEqual(blankRun.warnings, []);
  assert.deepEqual(blank.tables, []);
});

// 한도를 올려둔 계정이 일시적 DB 오류 때문에 말없이 50 으로 떨어지면 아무도
// 못 찾는다. 등록은 그대로 열어두되(기본값 반환) 코드가 찍힌 경고 한 줄은 남긴다.
test("일시적 DB 오류는 기본값으로 내려앉되 광고주 조회 실패를 경고 한 줄로 남긴다", async () => {
  const timeout = stubCtx({
    clients: { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } },
  });
  const run = await captureWarn(() => resolveRankKeywordLimit(timeout.ctx, "MML93-C07"));
  assert.deepEqual(run.value, { limit: DEFAULT_RANK_KEYWORD_LIMIT, source: "default" });
  assert.equal(run.warnings.length, 1);
  assert.match(run.warnings[0], /57014/);
  assert.match(run.warnings[0], /clients/);
  // 어느 계정이 잘못 50 을 받았는지 바로 찾을 수 있어야 한다(소문자로 정규화된 코드).
  assert.match(run.warnings[0], /mml93-c07/);
  assert.deepEqual(timeout.tables, ["clients"]);
});

test("운영팀 표 조회의 일시적 DB 오류도 기본값 + 경고 한 줄이다", async () => {
  const timeout = stubCtx({
    clients: { data: null, error: null },
    operation_team_codes: { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } },
  });
  const run = await captureWarn(() => resolveRankKeywordLimit(timeout.ctx, "mml93-t02"));
  assert.deepEqual(run.value, { limit: DEFAULT_RANK_KEYWORD_LIMIT, source: "default" });
  assert.equal(run.warnings.length, 1);
  assert.match(run.warnings[0], /57014/);
  assert.match(run.warnings[0], /operation_team_codes/);
  assert.deepEqual(timeout.tables, ["clients", "operation_team_codes"]);

  // 운영팀 표에도 컬럼이 없는 DB 는 여전히 조용해야 한다.
  const missing = stubCtx({
    clients: { data: null, error: null },
    operation_team_codes: { data: null, error: { code: "42703", message: "column does not exist" } },
  });
  const missingRun = await captureWarn(() => resolveRankKeywordLimit(missing.ctx, "mml93-t02"));
  assert.deepEqual(missingRun.value, { limit: DEFAULT_RANK_KEYWORD_LIMIT, source: "default" });
  assert.deepEqual(missingRun.warnings, []);
});

// 두 표 어디에도 행이 없는 계정은 정상이다. 오류가 아니므로 경고하면 안 된다.
test("행이 없는 계정은 오류가 아니라서 경고 없이 기본값을 쓴다", async () => {
  const noRow = stubCtx({
    clients: { data: null, error: null },
    operation_team_codes: { data: null, error: null },
  });
  const run = await captureWarn(() => resolveRankKeywordLimit(noRow.ctx, "mml93-t99"));
  assert.deepEqual(run.value, { limit: DEFAULT_RANK_KEYWORD_LIMIT, source: "default" });
  assert.deepEqual(run.warnings, []);
  assert.deepEqual(noRow.tables, ["clients", "operation_team_codes"]);
});

test("DB 트리거가 막은 등록은 옛 문구·새 문구 모두 한도 초과로 읽는다", () => {
  assert.equal(isRankKeywordLimitDbError({ code: "P0001", message: "키워드 등록 한도 200개를 모두 사용했습니다." }), true);
  // 마이그레이션 적용 전 트리거가 쓰던 문구.
  assert.equal(
    isRankKeywordLimitDbError({ code: "P0001", message: "순위 추적은 광고주 코드당 최대 50개까지만 등록할 수 있습니다." }),
    true,
  );
  assert.equal(isRankKeywordLimitDbError({ code: "23505", message: "duplicate key" }), false);
  assert.equal(isRankKeywordLimitDbError({ code: "P0001", message: "다른 제약" }), false);
  assert.equal(isRankKeywordLimitDbError(null), false);
});

test("한도 안내 문구는 남은 방법(관리자 문의)까지 알려준다", () => {
  assert.equal(
    rankKeywordLimitMessage(200, "product"),
    "키워드 등록 한도 200개를 모두 사용했습니다. 한도 상향이 필요하시면 관리자에게 문의해주세요.",
  );
  assert.equal(
    rankKeywordLimitMessage(50, "place"),
    "플레이스 키워드 등록 한도 50개를 모두 사용했습니다. 한도 상향이 필요하시면 관리자에게 문의해주세요.",
  );
  assert.equal(rankKeywordLimitMessage(50), rankKeywordLimitMessage(50, "product"));
});

test("한도 컬럼이 없는 응답은 저장 실패가 아니라 마이그레이션 대기로 읽는다", () => {
  assert.equal(isMissingRankKeywordLimitSchema({ code: "PGRST204" }), true);
  assert.equal(isMissingRankKeywordLimitSchema({ code: "PGRST205" }), true);
  assert.equal(isMissingRankKeywordLimitSchema({ code: "42703" }), true);
  assert.equal(isMissingRankKeywordLimitSchema({ message: "could not find the 'rank_keyword_limit' column in the schema cache" }), true);
  assert.equal(isMissingRankKeywordLimitSchema({ code: "23505", message: "duplicate key" }), false);
  assert.equal(isMissingRankKeywordLimitSchema(null), false);
});
