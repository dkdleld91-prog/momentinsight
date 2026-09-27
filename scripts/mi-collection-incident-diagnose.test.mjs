import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  EARLY_PROBE_CODES,
  EVIDENCE_QUERY,
  coordinationLines,
  earlyProbeExpected,
  evidenceLines,
} from "../docs/skills/mi-collection-incident/scripts/diagnose.mjs";

// 수집 장애 진단 도구(docs/skills/mi-collection-incident/scripts/diagnose.mjs)의 출력 규칙:
// 최근 증거 5행과 evidence.errorDetail, 코디네이션의 벤치 칸, 그리고 20260927120000 claim 의
// 주작업기 즉시 검증 조건과 같은 판정 힌트. 가져오기만으로는 DB·로그를 읽지 않는다.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migration = fs.readFileSync(
  path.join(root, "supabase", "migrations", "20260927120000_naver_shopping_standby_failure_isolation.sql"),
  "utf8",
);
const NOW = Date.parse("2026-09-27T12:00:00.000Z");
const at = (minutes) => new Date(NOW + minutes * 60000).toISOString();

test("the evidence query reads the latest five rows", () => {
  assert.match(EVIDENCE_QUERY, /^naver_shopping_failure_evidence\?/u);
  assert.match(EVIDENCE_QUERY, /[?&]order=occurred_at\.desc(&|$)/u);
  assert.match(EVIDENCE_QUERY, /[?&]limit=5(&|$)/u);
  assert.match(EVIDENCE_QUERY, /select=[^&]*\bevidence\b/u);
});

test("evidence lines print errorDetail only when present, before trace and diff", () => {
  const row = {
    occurred_at: at(-3), keyword: "남자팬티", error_code: "naver_page_navigation_failed",
    evidence: { version: 2, errorDetail: "No current window", trace: ["p1 ok"], diff: { a: 1 } },
  };
  const lines = evidenceLines(row);
  assert.equal(lines.length, 4);
  assert.match(lines[0], /남자팬티 naver_page_navigation_failed 2$/u);
  assert.equal(lines[1], "   errorDetail: No current window");
  assert.equal(lines[2], "   trace: p1 ok");
  assert.equal(lines[3], '   diff: {"a":1}');
  const without = evidenceLines({ ...row, evidence: { version: 2, trace: ["p1 ok"] } });
  assert.equal(without.some((line) => line.includes("errorDetail")), false);
  assert.equal(without.length, 2);
  assert.deepEqual(evidenceLines({ occurred_at: null, keyword: "k", error_code: "c", evidence: null }), [" - k c undefined"]);
});

test("coordination lines show the bench columns, the opener and the transient probe count", () => {
  const c = {
    primary_worker_id: "windows-desktop-primary", primary_seen_at: at(-12), lease_worker_id: null, current_page: 0,
    circuit_state: "closed", circuit_reason: null, failure_streak: 0, transient_system_probe_attempts: 0, runtime_version: "x",
    circuit_opened_by_worker: null, standby_failure_worker_id: "macbook-standby", standby_failure_streak: 2,
    standby_last_failure_at: at(-1), standby_last_failure_code: "naver_page_navigation_failed", standby_benched_until: at(29),
  };
  const { stale, benched, lines } = coordinationLines(c, NOW);
  assert.equal(stale, 12);
  assert.equal(benched, true);
  assert.match(lines[1], /일시 검증 0\/2/u);
  assert.match(lines[2], /^회로 연 워커 - · 대기기 벤치 중\(~.+\) · 대기기 실패 macbook-standby 2회 마지막 .+ naver_page_navigation_failed$/u);
  assert.equal(coordinationLines({ ...c, standby_benched_until: at(-1) }, NOW).benched, false);
  const legacy = { ...c };
  for (const key of ["circuit_opened_by_worker", "standby_failure_worker_id", "standby_failure_streak", "standby_last_failure_at", "standby_last_failure_code", "standby_benched_until"]) delete legacy[key];
  const old = coordinationLines(legacy, NOW);
  assert.equal(old.benched, false);
  assert.match(old.lines[2], /미적용/u);
});

test("the early-probe hint follows the claim rule: standby-originated, no own probe, no lease or cooldown, automatic reason", () => {
  const base = {
    circuit_state: "open", circuit_reason: "collecting:naver_page_timeout", failure_signature: "collecting:naver_page_timeout",
    circuit_opened_by_worker: "macbook-standby", primary_worker_id: "windows-desktop-primary", transient_system_probe_attempts: 0,
    lease_until: null, cooldown_until: null,
  };
  assert.equal(earlyProbeExpected(base, NOW), true);
  for (const reason of ["probe_incomplete", "probe_interrupted", "transient_recovery_manual_required"]) {
    assert.equal(earlyProbeExpected({ ...base, circuit_reason: reason }, NOW), true, reason);
  }
  assert.equal(earlyProbeExpected({ ...base, circuit_reason: "navigating:native_host_collection_failed", failure_signature: "navigating:native_host_collection_failed" }, NOW), true);
  const refused = {
    closed: { circuit_state: "closed" },
    halfOpen: { circuit_state: "half_open" },
    noOpener: { circuit_opened_by_worker: null },
    primaryEpisode: { circuit_opened_by_worker: "windows-desktop-primary" },
    ownProbeCounted: { transient_system_probe_attempts: 1 },
    liveLease: { lease_until: at(5) },
    liveCooldown: { cooldown_until: at(5) },
    manualStop: { circuit_reason: "manual_stop" },
    manualStopWithColon: { circuit_reason: "owner:maintenance" },
    stopMimickingASignature: { circuit_reason: "collecting:naver_page_script_failed" },
    securityBlock: { circuit_reason: "probe_security_block" },
    handoffReady: { circuit_reason: "transient_standby_handoff_ready" },
    noAutomaticExit: { circuit_reason: "collecting:naver_next_data_schema_drift", failure_signature: "collecting:naver_next_data_schema_drift" },
  };
  for (const [name, change] of Object.entries(refused)) assert.equal(earlyProbeExpected({ ...base, ...change }, NOW), false, name);
  assert.equal(earlyProbeExpected({ ...base, lease_until: at(-1), cooldown_until: at(-1) }, NOW), true, "expired lease and cooldown do not hold it");
});

test("the hint's code list is the claim function's early-probe list", () => {
  const claim = migration.match(/create or replace function public\.mi_claim_naver_shopping_worker_lane\([\s\S]*?\n\$\$;/u)?.[0] || "";
  const listed = claim.match(/primary_after_standby_failure := coalesce\([\s\S]*?split_part\(current_row\.circuit_reason, ':', 2\) in \(([\s\S]*?)\)/u)?.[1] || "";
  const codes = [...listed.matchAll(/'([a-z0-9_]+)'/gu)].map((match) => match[1]);
  assert.equal(codes.length, 18);
  assert.deepEqual(EARLY_PROBE_CODES, codes);
});
