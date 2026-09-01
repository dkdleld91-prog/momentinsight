// 재시도가 소진된 채 남아 있는 순위 추적기(잔존 실패)를 하루 1회 세어 0건이 아니면
// 실패로 보고한다.
//
// 왜 별도 감시가 필요한가: 상품 레인의 실패 코드 다수는 격리 코드라 다른 키워드 수집을
// 막지 않는다. 그래서 last_checked_at 이 계속 갱신되고, /api/rank-collection-health 의
// 정체 감지(queueStalled)에는 영원히 걸리지 않는다 — 완전한 관측 사각지대다.
// 또한 상품 테이블은 자동 재큐(src/server/naver-rank-requeue.mjs)에서 구조적으로
// 제외되어 있어(runRankRequeuePass 의 fail-closed 분기) 스스로 풀리지도 않는다.
//
// 판정 기준은 자동 재큐가 쓰는 것과 같은 컬럼·같은 임계값이다:
//   status = 'active' AND last_error IS NOT NULL AND retry_count >= RANK_RETRY_EXHAUSTED_AT
// 임계값은 하드코딩하지 않고 서버 상수를 그대로 가져온다(상수가 바뀌면 같이 움직인다).
//
// 읽기 전용이다. select 만 하고 limit=0 + Prefer: count=exact 로 개수만 받는다 —
// 추적기 id·키워드·상품번호 같은 계정 데이터를 로그에 남기지 않는다.
import fs from "node:fs";
import path from "node:path";

import { RANK_RETRY_EXHAUSTED_AT } from "../src/server/naver-rank-requeue.mjs";

const LANES = [
  { key: "product", table: "naver_rank_trackers" },
  { key: "place", table: "naver_place_rank_trackers" },
];

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .reduce((acc, line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return acc;
      const index = trimmed.indexOf("=");
      if (index < 1) return acc;
      const key = trimmed.slice(0, index).trim();
      let value = trimmed.slice(index + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      acc[key] = value;
      return acc;
    }, {});
}

const env = {
  ...loadEnvFile(path.join(process.cwd(), "06_Supabase_연동", ".env.local")),
  ...loadEnvFile(path.join(process.cwd(), ".env.local")),
  ...process.env,
};

const supabaseUrl = String(env.SUPABASE_URL || "").trim();
const serviceKey = String(env.SUPABASE_SECRET_KEY || "").trim();
const checkedAt = new Date().toISOString();

function fail(code, message) {
  console.error(JSON.stringify({ ok: false, code, message, checkedAt }, null, 2));
  process.exit(1);
}

if (!supabaseUrl || !serviceKey) {
  fail(
    "RANK_RESIDUAL_AUDIT_DATABASE_MISSING",
    "SUPABASE_URL 과 SUPABASE_SECRET_KEY 가 필요합니다. 워크플로 시크릿을 등록하세요.",
  );
}

async function laneResidualCount(table) {
  const url = new URL(`/rest/v1/${table}`, supabaseUrl);
  url.searchParams.set("select", "id");
  url.searchParams.set("limit", "0");
  url.searchParams.set("status", "eq.active");
  url.searchParams.set("last_error", "not.is.null");
  url.searchParams.set("retry_count", `gte.${RANK_RETRY_EXHAUSTED_AT}`);
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
      prefer: "count=exact",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok && response.status !== 206) {
    throw new Error(`${table}_http_${response.status}`);
  }
  const total = Number(String(response.headers.get("content-range") || "").split("/")[1]);
  if (!Number.isSafeInteger(total) || total < 0) throw new Error(`${table}_count_unavailable`);
  return total;
}

let lanes;
try {
  lanes = await Promise.all(LANES.map(async (lane) => ({
    lane: lane.key,
    table: lane.table,
    residualCount: await laneResidualCount(lane.table),
  })));
} catch (error) {
  fail("RANK_RESIDUAL_AUDIT_QUERY_FAILED", String(error?.message || "residual_query_failed"));
}

const residualCount = lanes.reduce((sum, lane) => sum + lane.residualCount, 0);
const report = {
  ok: residualCount === 0,
  code: residualCount === 0 ? "RANK_RESIDUAL_NONE" : "RANK_RESIDUAL_FAILURES_PRESENT",
  residualCount,
  retryExhaustedAt: RANK_RETRY_EXHAUSTED_AT,
  lanes,
  checkedAt,
};

if (residualCount > 0) {
  console.error(JSON.stringify(report, null, 2));
  console.error(`재시도가 소진된 순위 추적기가 ${residualCount}건 남아 있습니다. docs/RUNBOOK.md 증상 ④를 따르세요.`);
  process.exit(1);
}

console.log(JSON.stringify(report, null, 2));
