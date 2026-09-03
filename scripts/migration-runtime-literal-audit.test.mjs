import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  RUNTIME_LITERAL_ALLOWLIST,
  auditMigrationRuntimeLiterals,
  collectFinalFunctionDeclarations,
  formatRuntimeLiteralAudit,
  stripSqlComments,
} from "./migration-runtime-literal-audit.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationDirectory = path.join(root, "supabase", "migrations");

function scratch(files) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mi-runtime-literal-audit-"));
  for (const [name, source] of Object.entries(files)) {
    fs.writeFileSync(path.join(directory, name), source, "utf8");
  }
  return directory;
}

function definition(name, condition) {
  return [
    `create or replace function public.${name}(p_value text)`,
    "returns boolean",
    "language plpgsql",
    "security invoker",
    "set search_path = ''",
    "as $$",
    "begin",
    `  if ${condition} then`,
    "    return false;",
    "  end if;",
    "  return true;",
    "end;",
    "$$;",
    "",
  ].join("\n");
}

test("주석은 지우고 문자열 리터럴은 보존한다", () => {
  const stripped = stripSqlComments(
    "-- runtime '1.1.21'\nselect '1.1.21';\n/* '9.9.9' */\nselect 'keep''me';\n",
  );
  assert.equal(stripped.includes("select '1.1.21';"), true);
  assert.equal(stripped.includes("-- runtime"), false);
  assert.equal(/'9\.9\.9'/u.test(stripped), false);
  assert.equal(stripped.includes("'keep''me'"), true);
  assert.equal(stripped.split("\n").length, "-- x\nselect 1;\n/* y */\nselect 2;\n".split("\n").length);
});

test("같은 함수가 여러 번 선언되면 마지막 선언만 감사한다", () => {
  const directory = scratch({
    "20260101000000_first.sql": definition("mi_demo_gate", "p_value <> '1.1.20'"),
    "20260102000000_second.sql": definition("mi_demo_gate", "p_value is null"),
  });
  const declarations = collectFinalFunctionDeclarations(directory);
  assert.deepEqual(declarations.map((entry) => entry.function), ["public.mi_demo_gate"]);
  assert.equal(declarations[0].file, "20260102000000_second.sql");

  const result = auditMigrationRuntimeLiterals({ migrationDirectory: directory, allowlist: [] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.violations, []);
});

test("마지막 선언에 semver 리터럴이 남으면 실패한다", () => {
  const directory = scratch({
    "20260101000000_first.sql": definition("mi_demo_gate", "p_value is null"),
    "20260102000000_second.sql": definition("mi_demo_gate", "p_value <> '1.1.21'"),
  });
  const result = auditMigrationRuntimeLiterals({ migrationDirectory: directory, allowlist: [] });
  assert.equal(result.ok, false);
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].function, "public.mi_demo_gate");
  assert.deepEqual(result.violations[0].versions, ["1.1.21"]);
  assert.match(formatRuntimeLiteralAudit(result), /허용목록에 없는 런타임 리터럴/u);
});

test("마지막 선언에 64자리 지문 리터럴이 남아도 실패한다", () => {
  const fingerprint = "a".repeat(64);
  const directory = scratch({
    "20260101000000_only.sql": definition("mi_demo_gate", `p_value <> '${fingerprint}'`),
  });
  const result = auditMigrationRuntimeLiterals({ migrationDirectory: directory, allowlist: [] });
  assert.equal(result.ok, false);
  assert.deepEqual(result.violations[0].fingerprints, [fingerprint]);
});

test("주석 안의 버전 값은 위반이 아니다", () => {
  const directory = scratch({
    "20260101000000_only.sql": [
      "-- 되돌리기: 런타임 '1.1.20' 지문 " + "b".repeat(64),
      definition("mi_demo_gate", "p_value is null"),
    ].join("\n"),
  });
  const result = auditMigrationRuntimeLiterals({ migrationDirectory: directory, allowlist: [] });
  assert.equal(result.ok, true);
});

test("허용목록에 오른 함수는 통과하고, 낡은 허용목록은 실패한다", () => {
  const directory = scratch({
    "20260101000000_only.sql": definition("mi_demo_gate", "p_value <> '1.1.21'"),
  });
  const allowed = auditMigrationRuntimeLiterals({
    migrationDirectory: directory,
    allowlist: [{ function: "public.mi_demo_gate", reason: "테스트용 의도적 고정" }],
  });
  assert.equal(allowed.ok, true);
  assert.deepEqual(allowed.violations, []);

  const stale = auditMigrationRuntimeLiterals({
    migrationDirectory: directory,
    allowlist: [
      { function: "public.mi_demo_gate", reason: "테스트용 의도적 고정" },
      { function: "public.mi_gone", reason: "이미 사라진 함수" },
    ],
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.staleAllowlist.length, 1);
  assert.equal(stale.staleAllowlist[0].function, "public.mi_gone");

  const noReason = auditMigrationRuntimeLiterals({
    migrationDirectory: directory,
    allowlist: [{ function: "public.mi_demo_gate", reason: "  " }],
  });
  assert.equal(noReason.ok, false);
  assert.deepEqual(noReason.missingReasons, ["public.mi_demo_gate"]);
});

test("실제 supabase/migrations 는 허용목록 밖 런타임 리터럴이 없다", () => {
  const result = auditMigrationRuntimeLiterals({ migrationDirectory });
  assert.equal(formatRuntimeLiteralAudit(result), "");
  assert.equal(result.ok, true);
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.staleAllowlist, []);
  assert.deepEqual(result.bodylessFunctions, []);
  assert.equal(result.functionCount > 50, true);
});

test("허용목록은 런타임 입구 게이트 하나뿐이고 사유가 붙어 있다", () => {
  assert.deepEqual(
    RUNTIME_LITERAL_ALLOWLIST.map((entry) => entry.function),
    ["public.mi_report_naver_shopping_worker_progress"],
  );
  for (const entry of RUNTIME_LITERAL_ALLOWLIST) {
    assert.equal(String(entry.reason || "").trim().length > 20, true, entry.function);
  }
  const result = auditMigrationRuntimeLiterals({ migrationDirectory });
  const gate = result.carriers.find(
    (entry) => entry.function === "public.mi_report_naver_shopping_worker_progress",
  );
  assert.notEqual(gate, undefined);
  assert.deepEqual(gate.versions, ["1.1.21"]);
});

test("계정 우선 등록·케이던스 RPC 는 더 이상 리터럴을 쓰지 않는다", () => {
  const result = auditMigrationRuntimeLiterals({ migrationDirectory });
  const carrierNames = result.carriers.map((entry) => entry.function);
  for (const name of [
    "public.mi_enqueue_naver_shopping_account_priority",
    "public.mi_set_naver_shopping_worker_cadence",
    "public.mi_get_naver_shopping_worker_operations",
    "mi_internal.mi_naver_shopping_account_priority_trigger_gate",
  ]) {
    assert.equal(carrierNames.includes(name), false, name);
  }
  const declarations = collectFinalFunctionDeclarations(migrationDirectory);
  const finalFiles = Object.fromEntries(
    declarations.map((entry) => [entry.function, entry.file]),
  );
  assert.equal(
    finalFiles["public.mi_enqueue_naver_shopping_account_priority"],
    "20260903213000_naver_shopping_runtime_neutral_admission_rpcs.sql",
  );
  assert.equal(
    finalFiles["public.mi_set_naver_shopping_worker_cadence"],
    "20260903213000_naver_shopping_runtime_neutral_admission_rpcs.sql",
  );
  assert.equal(
    finalFiles["public.mi_get_naver_shopping_worker_operations"],
    "20260903213000_naver_shopping_runtime_neutral_admission_rpcs.sql",
  );
});
