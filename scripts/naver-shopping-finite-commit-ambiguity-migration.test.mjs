import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationDirectory = path.join(repositoryRoot, "supabase", "migrations");
const migrationNames = fs.readdirSync(migrationDirectory)
  .filter((name) => name.endsWith("_naver_shopping_finite_commit_checked_count_ambiguity.sql"));
const migration = migrationNames.length === 1
  ? fs.readFileSync(path.join(migrationDirectory, migrationNames[0]), "utf8")
  : "";
const deployedFiniteMigration = fs.readFileSync(
  path.join(migrationDirectory, "20260826035440_naver_shopping_stable_finite_window_v1.sql"),
  "utf8",
);

function functionBlock(source, schema, name) {
  const pattern = new RegExp(
    `create or replace function ${schema.replace(".", "\\.")}\\.${name}\\([\\s\\S]*?\\n\\$\\$;`,
    "iu",
  );
  return source.match(pattern)?.[0] || "";
}

test("additive migration removes the finite commit checked_count ambiguity", () => {
  assert.equal(migrationNames.length, 1, "finite commit ambiguity migration must exist exactly once");
  const finiteCommit = functionBlock(
    migration,
    "public",
    "mi_commit_naver_shopping_finite_worker_result",
  );
  assert.ok(finiteCommit, "migration must redefine the finite commit RPC");
  assert.match(finiteCommit, /finite_checked_count integer/iu);
  assert.match(
    finiteCommit,
    /finite_checked_count\s*:=\s*\(p_snapshot ->> 'checked_count'\)::integer/iu,
  );
  assert.match(finiteCommit, /matched_rank not between 1 and finite_checked_count/iu);
  assert.match(finiteCommit, /market_total is distinct from finite_checked_count/iu);
  assert.match(finiteCommit, /committed\.checked_count = finite_checked_count/iu);
  assert.doesNotMatch(finiteCommit, /\n\s*checked_count integer;/iu);
  assert.doesNotMatch(finiteCommit, /committed\.checked_count = checked_count/iu);
});

test("finite commit body changes only the ambiguous local identifier", () => {
  const deployedFiniteCommit = functionBlock(
    deployedFiniteMigration,
    "public",
    "mi_commit_naver_shopping_finite_worker_result",
  );
  const correctedFiniteCommit = functionBlock(
    migration,
    "public",
    "mi_commit_naver_shopping_finite_worker_result",
  );
  assert.ok(deployedFiniteCommit);
  assert.ok(correctedFiniteCommit);
  assert.equal(
    correctedFiniteCommit.replaceAll("finite_checked_count", "checked_count"),
    deployedFiniteCommit,
  );
});

test("finite commit redefinition preserves exact-ID, privilege, and cadence boundaries", () => {
  const finiteCommit = functionBlock(
    migration,
    "public",
    "mi_commit_naver_shopping_finite_worker_result",
  );
  assert.match(finiteCommit, /security invoker\s+set search_path = ''/iu);
  assert.match(finiteCommit, /p_tracker_id is distinct from 'c0ccded2-9bf7-488e-af8d-00898c0a1ff8'::uuid/iu);
  assert.match(finiteCommit, /p_product_id is distinct from '13327339525'/iu);
  assert.match(finiteCommit, /target\.parent_catalog_id is distinct from '59776958987'/iu);
  assert.match(finiteCommit, /relatedCatalogRelationBasis' is distinct from 'catalog_seller_product_id'/iu);
  assert.match(finiteCommit, /catalogSellerProductIds/iu);
  assert.match(finiteCommit, /finite_window_committed/iu);
  assert.doesNotMatch(finiteCommit, /update public\.naver_shopping_worker_coordination/iu);
  assert.doesNotMatch(finiteCommit, /success_streak\s*=|stability_started_at\s*=|cadence_minutes\s*=/iu);
  assert.match(
    migration,
    /revoke all on function public\.mi_commit_naver_shopping_finite_worker_result\([^)]+\)\s+from public, anon, authenticated, service_role/iu,
  );
  assert.match(
    migration,
    /grant execute on function public\.mi_commit_naver_shopping_finite_worker_result\([^)]+\)\s+to service_role/iu,
  );
});

test("migration is transactional and performs no top-level state repair", () => {
  assert.match(migration, /^begin;/imu);
  assert.match(migration, /set local lock_timeout = '5s'/iu);
  assert.match(migration, /commit;\s*$/iu);
  const finiteCommit = functionBlock(
    migration,
    "public",
    "mi_commit_naver_shopping_finite_worker_result",
  );
  const topLevelMigration = migration.replace(finiteCommit, "");
  assert.doesNotMatch(
    topLevelMigration,
    /(?:insert into|update|delete from)\s+public\.(?:naver_rank_trackers|naver_rank_snapshots|naver_shopping_scheduler_events|naver_shopping_worker_coordination)/iu,
  );
});

test("PGlite reproduces SQLSTATE 42702 for the deployed predicate and accepts the fixed local", async (t) => {
  const database = new PGlite();
  t.after(async () => database.close());
  await database.exec(`
    create table committed (checked_count integer not null);
    insert into committed values (94);
    create function old_finite_commit(p_checked_count integer) returns integer
    language plpgsql as $$
    declare
      checked_count integer;
      matched integer;
    begin
      checked_count := p_checked_count;
      select count(*) into matched
      from committed
      where committed.checked_count = checked_count;
      return matched;
    end
    $$;
  `);

  await assert.rejects(
    database.query("select old_finite_commit(94) as matched"),
    (error) => error?.code === "42702",
  );

  await database.exec(`
    create or replace function fixed_finite_commit(p_checked_count integer) returns integer
    language plpgsql as $$
    declare
      finite_checked_count integer;
      matched integer;
    begin
      finite_checked_count := p_checked_count;
      select count(*) into matched
      from committed
      where committed.checked_count = finite_checked_count;
      return matched;
    end
    $$;
  `);
  const fixed = await database.query("select fixed_finite_commit(94) as matched");
  assert.deepEqual(fixed.rows, [{ matched: 1 }]);
});
