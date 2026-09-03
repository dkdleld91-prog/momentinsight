// supabase/migrations 의 "최종 재선언" 함수 본문에 런타임 semver / 64자리 지문
// 리터럴이 남아 있는지 정적으로 감사한다.
//
// 왜 필요한가: 20260831100525 의 account-priority 트리거 게이트가 런타임
// '1.1.20' 과 그 지문을 리터럴로 검사한 탓에, 1.1.21 인상 직후 모든 수집
// 클레임이 P0001 로 거부되며 약 2시간 수집이 멈췄다.  같은 계열 사고는 리터럴이
// 조용히 되살아나기만 하면 언제든 재발하므로, 릴리스 게이트에서 기계적으로 막는다.
//
// 판정 기준
//   - 같은 함수가 여러 마이그레이션에서 재선언되면 "파일명 정렬 기준 마지막"
//     선언만 본다(실제로 DB 에 남는 정의).
//   - 주석(-- , /* */)은 제외하고 함수 본문($$ ... $$)만 본다.
//   - 의도적으로 버전에 고정되어야 하는 함수는 RUNTIME_LITERAL_ALLOWLIST 에
//     사유와 함께 명시한다.  허용목록에 없는 새 리터럴이 생기면 실패하고,
//     허용목록 항목이 사라지거나 리터럴을 잃어도(= 근거가 낡음) 실패한다.

import fs from "node:fs";
import path from "node:path";

export const RUNTIME_LITERAL_ALLOWLIST = Object.freeze([
  Object.freeze({
    function: "public.mi_report_naver_shopping_worker_progress",
    reason:
      "런타임 입구 게이트. '어떤 런타임을 승인할 것인가'를 정의하는 함수라 버전 고정이 설계 그 자체다."
      + " 런타임 인상 마이그레이션이 매번 이 함수를 재선언하면서 버전·지문을 올린다."
      + " coordination.runtime_version/fingerprint 를 기록하는 유일한 함수이기도 하다.",
  }),
]);

const FUNCTION_DECLARATION_PATTERN =
  /create\s+or\s+replace\s+function\s+([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\s*\(/giu;
const BODY_TAG_PATTERN = /\bas\s+(\$[a-zA-Z_]*\$)/u;
const SEMVER_LITERAL_PATTERN = /'(\d+\.\d+\.\d+)'/gu;
const FINGERPRINT_LITERAL_PATTERN = /'([0-9a-fA-F]{64})'/gu;

// 문자열 리터럴은 보존하고 주석만 공백으로 지운다.  주석에 적힌 버전 값은
// 사고를 일으키지 않으므로 감사 대상이 아니다.
export function stripSqlComments(sql) {
  let out = "";
  let index = 0;
  while (index < sql.length) {
    const pair = sql.slice(index, index + 2);
    if (pair === "--") {
      const newline = sql.indexOf("\n", index);
      const stop = newline === -1 ? sql.length : newline;
      out += " ".repeat(stop - index);
      index = stop;
      continue;
    }
    if (pair === "/*") {
      const closing = sql.indexOf("*/", index + 2);
      const stop = closing === -1 ? sql.length : closing + 2;
      for (let cursor = index; cursor < stop; cursor += 1) {
        out += sql[cursor] === "\n" ? "\n" : " ";
      }
      index = stop;
      continue;
    }
    if (sql[index] === "'") {
      let cursor = index + 1;
      while (cursor < sql.length) {
        if (sql[cursor] === "'" && sql[cursor + 1] === "'") {
          cursor += 2;
          continue;
        }
        if (sql[cursor] === "'") {
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      out += sql.slice(index, cursor);
      index = cursor;
      continue;
    }
    out += sql[index];
    index += 1;
  }
  return out;
}

export function collectFinalFunctionDeclarations(migrationDirectory, files) {
  const names = (files || fs.readdirSync(migrationDirectory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const declarations = new Map();
  for (const name of names) {
    const source = fs.readFileSync(path.join(migrationDirectory, name), "utf8");
    FUNCTION_DECLARATION_PATTERN.lastIndex = 0;
    let match = FUNCTION_DECLARATION_PATTERN.exec(source);
    while (match) {
      const start = match.index;
      const tag = BODY_TAG_PATTERN.exec(source.slice(start, start + 4000));
      let body = "";
      let end = start + match[0].length;
      if (tag) {
        const bodyStart = start + tag.index + tag[0].length;
        const bodyEnd = source.indexOf(tag[1], bodyStart);
        body = source.slice(bodyStart, bodyEnd === -1 ? source.length : bodyEnd);
        end = bodyEnd === -1 ? source.length : bodyEnd;
      }
      declarations.set(`${match[1]}.${match[2]}`, {
        function: `${match[1]}.${match[2]}`,
        file: name,
        line: source.slice(0, start).split("\n").length,
        body,
        hasBody: Boolean(tag),
      });
      FUNCTION_DECLARATION_PATTERN.lastIndex = end;
      match = FUNCTION_DECLARATION_PATTERN.exec(source);
    }
  }
  return [...declarations.values()];
}

export function auditMigrationRuntimeLiterals(options = {}) {
  const migrationDirectory = options.migrationDirectory || "supabase/migrations";
  const allowlist = options.allowlist || RUNTIME_LITERAL_ALLOWLIST;
  const allowed = new Set(allowlist.map((entry) => entry.function));
  const declarations = collectFinalFunctionDeclarations(migrationDirectory, options.files);

  const carriers = [];
  const bodylessFunctions = [];
  for (const declaration of declarations) {
    if (!declaration.hasBody) {
      bodylessFunctions.push(declaration.function);
      continue;
    }
    const clean = stripSqlComments(declaration.body);
    const versions = [...new Set([...clean.matchAll(SEMVER_LITERAL_PATTERN)].map((hit) => hit[1]))];
    const fingerprints = [
      ...new Set([...clean.matchAll(FINGERPRINT_LITERAL_PATTERN)].map((hit) => hit[1].toLowerCase())),
    ];
    if (versions.length || fingerprints.length) {
      carriers.push({
        function: declaration.function,
        file: declaration.file,
        line: declaration.line,
        versions,
        fingerprints,
      });
    }
  }

  const violations = carriers.filter((entry) => !allowed.has(entry.function));
  const carrierNames = new Set(carriers.map((entry) => entry.function));
  const declaredNames = new Set(declarations.map((entry) => entry.function));
  const staleAllowlist = allowlist
    .filter((entry) => !carrierNames.has(entry.function))
    .map((entry) => ({
      function: entry.function,
      reason: declaredNames.has(entry.function)
        ? "허용목록에 있으나 더 이상 런타임 리터럴을 쓰지 않습니다. 허용목록에서 제거하세요."
        : "허용목록에 있으나 마이그레이션에 그런 함수 선언이 없습니다.",
    }));
  const missingReasons = allowlist
    .filter((entry) => !String(entry.reason || "").trim())
    .map((entry) => entry.function);

  return {
    ok: violations.length === 0 && staleAllowlist.length === 0 && missingReasons.length === 0,
    functionCount: declarations.length,
    bodylessFunctions,
    carriers,
    violations,
    staleAllowlist,
    missingReasons,
    allowlist: allowlist.map((entry) => entry.function),
  };
}

export function formatRuntimeLiteralAudit(result) {
  const lines = [];
  for (const entry of result.violations) {
    lines.push(
      `- 허용목록에 없는 런타임 리터럴: ${entry.function} (${entry.file}:${entry.line})`
      + ` versions=${JSON.stringify(entry.versions)}`
      + ` fingerprints=${JSON.stringify(entry.fingerprints.map((value) => `${value.slice(0, 12)}…`))}`,
    );
  }
  for (const entry of result.staleAllowlist) {
    lines.push(`- 허용목록이 낡았습니다: ${entry.function} — ${entry.reason}`);
  }
  for (const name of result.missingReasons) {
    lines.push(`- 허용목록 항목에 사유가 없습니다: ${name}`);
  }
  return lines.join("\n");
}
