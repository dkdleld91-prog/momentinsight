import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationDirectory = path.join(repositoryRoot, "supabase", "migrations");
const migrationName = "20260828210000_account_rank_keyword_limit.sql";
const migrationPath = path.join(migrationDirectory, migrationName);
const migration = fs.readFileSync(migrationPath, "utf8");

test("계정별 키워드 한도 마이그레이션은 한 트랜잭션에 100줄 미만으로 담긴다", () => {
  // 대표님이 손으로 실행하는 파일이다. 컬럼과 트리거가 갈라지면 트리거만 먼저
  // 들어갔을 때 모든 상품 추적 등록이 42703 으로 죽는다.
  assert.ok(migration.split("\n").length <= 100, `${migrationName} 은 100줄 이하여야 한다`);
  assert.ok(migration.trimStart().startsWith("begin;"));
  assert.ok(migration.trimEnd().endsWith("commit;"));
});

test("광고주·운영팀 두 계정 표에 한도 컬럼을 재실행 안전하게 더한다", () => {
  assert.ok(migration.includes("alter table public.clients\n  add column if not exists rank_keyword_limit integer;"));
  assert.ok(migration.includes("alter table public.operation_team_codes\n  add column if not exists rank_keyword_limit integer;"));
  assert.equal((migration.match(/add column if not exists rank_keyword_limit/g) || []).length, 2);

  // 오타 방어용 상한. 실제 운영 상한은 서버 상수(MAX_RANK_KEYWORD_LIMIT)가 좁힌다.
  assert.ok(migration.includes("constraint clients_rank_keyword_limit_range"));
  assert.ok(migration.includes("constraint operation_team_codes_rank_keyword_limit_range"));
  assert.equal((migration.match(/between 1 and 10000/g) || []).length, 2);
  assert.equal((migration.match(/exception when duplicate_object then null;/g) || []).length, 2);
});

test("DB 최후 방어선 트리거가 하드코딩 50 대신 계정별 한도를 읽는다", () => {
  assert.ok(migration.includes("create or replace function public.enforce_naver_rank_tracker_limit()"));
  // 기존 트리거 바인딩과 권한을 유지하려면 drop/create 가 아니라 replace 여야 한다.
  assert.ok(!/drop\s+trigger/i.test(migration));

  // 총관리자 코드는 값과 무관하게 무제한이다.
  assert.ok(migration.includes("if lower(coalesce(new.agency_code, '')) = 'mml93-a01' then"));

  // 광고주 행이 있으면 그 값이 이긴다. 값이 null 이어도 운영팀 표로 새지 않는다.
  assert.ok(migration.includes("from public.clients c"));
  assert.ok(migration.includes("if not found then"));
  assert.ok(migration.includes("from public.operation_team_codes t"));
  assert.ok(migration.includes("allowed_limit := coalesce(allowed_limit, 50);"));

  assert.ok(migration.includes("perform pg_advisory_xact_lock(hashtext(lower(new.agency_code)));"));
  assert.ok(migration.includes("if active_count >= allowed_limit then"));
  assert.ok(!migration.includes("active_count >= 50"));
});

test("한도 검사는 '활성으로 들어오는 순간'에만 돌고 평범한 갱신은 그냥 지나간다", () => {
  // 트리거는 `before insert or update of agency_code, status` 로 걸려 있다.
  // 포스트그레스의 `update of` 는 값이 그대로여도 그 칼럼이 UPDATE 문에 대입되기만
  // 하면 깨어난다. 수집기(updateTrackerAfterCheck)가 회차마다 status 를 다시 써넣으니
  // 상태만 보고 막으면, 한도를 내려 잡은 계정의 기존 키워드가 통째로 P0001 로 죽는다.
  assert.ok(migration.includes("TG_OP = 'INSERT'"));
  // INSERT 에는 old 가 배정돼 있지 않다. or 의 단락 평가에 기대지 않고 분기를 가른다.
  assert.ok(migration.includes("if TG_OP = 'INSERT' then"));
  assert.ok(migration.includes("old.status is distinct from new.status"));
  assert.ok(migration.includes("old.agency_code is distinct from new.agency_code"));

  // 상태만 보는 한 줄짜리 옛 게이트가 남아 있으면 위 전환 검사가 무력해진다.
  assert.ok(!migration.includes("if new.status = 'active' then"));

  // UPDATE 로 들어온 자기 행은 이미 활성으로 세어져 있다. 빼지 않으면 재개·코드
  // 변경이 한도 안인데도 한 칸 모자란 것처럼 막힌다.
  assert.ok(migration.includes("and id <> new.id"));
});

test("트리거 예외 문구가 서버 안내와 같은 우리말로 올라온다", () => {
  assert.ok(migration.includes(
    "raise exception '키워드 등록 한도 %개를 모두 사용했습니다. 한도 상향이 필요하시면 관리자에게 문의해주세요.', allowed_limit",
  ));
  assert.ok(migration.includes("using errcode = 'P0001';"));
});

test("트리거 함수의 굳힌 실행 권한을 그대로 다시 세운다", () => {
  assert.ok(migration.includes(
    "revoke execute on function public.enforce_naver_rank_tracker_limit() from public, anon, authenticated;",
  ));
  assert.ok(migration.includes(
    "grant execute on function public.enforce_naver_rank_tracker_limit() to service_role;",
  ));
  assert.ok(migration.includes("security definer"));
  assert.ok(migration.includes("set search_path = public"));
});

test("이 마이그레이션은 순위 잠금 목록에 등록돼 있다", () => {
  const lock = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "scripts", "protected-rank-features.lock.json"), "utf8"));
  const entry = lock.files.find((file) => file.file === `supabase/migrations/${migrationName}`);
  assert.ok(entry, "보호 잠금에 순위 마이그레이션으로 등록돼야 한다");
  assert.equal(entry.rankMigration, true);
  assert.match(entry.sha256, /^[0-9a-f]{64}$/u);
});
