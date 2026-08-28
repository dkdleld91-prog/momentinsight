import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const migrationPath = "supabase/migrations/20260827050000_naver_shopping_exact_parent_relation_guard.sql";
const recoveryMigrationPath = "supabase/migrations/20260828034500_naver_shopping_exact_parent_guard_runtime_recovery.sql";
const rankerPath = "src/server/handlers/naver-shopping-rank.mjs";

test("exact parent snapshot guard accepts only a direct seller-to-catalog relationship for every tracker", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");
  assert.match(sql, /create or replace function mi_internal\.mi_guard_naver_shopping_exact_parent_snapshot\(\)/iu);
  assert.match(sql, /security invoker\s+set search_path = ''/iu);
  assert.match(sql, /trackingRankSource'\s+is distinct from\s+'related_catalog'/iu);
  assert.match(sql, /relatedCatalogRelationBasis'\s+is distinct from\s+'catalog_seller_product_id'/iu);
  assert.match(sql, /catalogSellerProductIds'[\s\S]*@>[\s\S]*jsonb_build_array\([\s\S]*target_product_id[\s\S]*\)/iu);
  assert.match(sql, /related_catalog_id\s*:=[\s\S]*relatedCatalogProductId/iu);
  assert.match(sql, /selected_catalog_id\s*:=[\s\S]*catalogId/iu);
  assert.match(sql, /selected_catalog_id\s+is distinct from\s+related_catalog_id/iu);
  assert.match(sql, /before insert or update[\s\S]*on public\.naver_rank_snapshots/iu);
  assert.match(sql, /raise exception 'naver_shopping_exact_parent_relation_invalid'/iu);
  assert.doesNotMatch(sql, /c0ccded2-9bf7-488e-af8d-00898c0a1ff8|13327339525|59776958987/iu);
  assert.doesNotMatch(sql, /thumbnail|image|product_title/iu);
});

test("the ranker contains no switch that can restore metadata-based parent inference", () => {
  const source = fs.readFileSync(rankerPath, "utf8");
  assert.doesNotMatch(source, /model_brand_category|keyword_brand_category/iu);
  assert.doesNotMatch(
    source,
    /(?:^|[^A-Za-z0-9_$])relatedCatalogItemsFromOrganic|requireDirectCatalogRelation/iu,
  );
});

test("runtime recovery keeps the exact-id guard while avoiding pseudo pg_catalog functions", () => {
  const sql = fs.readFileSync(recoveryMigrationPath, "utf8");
  assert.match(sql, /^begin;/imu);
  assert.match(sql, /commit;\s*$/iu);
  assert.match(sql, /create or replace function mi_internal\.mi_guard_naver_shopping_exact_parent_snapshot\(\)/iu);
  assert.match(sql, /security invoker\s+set search_path = ''/iu);
  assert.match(sql, /trackingRankSource'\s+is distinct from\s+'related_catalog'/iu);
  assert.match(sql, /relatedCatalogRelationBasis'\s+is distinct from\s+'catalog_seller_product_id'/iu);
  assert.match(sql, /catalogSellerProductIds'[\s\S]*@>[\s\S]*jsonb_build_array\([\s\S]*target_product_id[\s\S]*\)/iu);
  assert.match(sql, /selected_catalog_id\s+is distinct from\s+related_catalog_id/iu);
  assert.match(sql, /raise exception 'naver_shopping_exact_parent_relation_invalid'/iu);
  assert.match(sql, /trigger_row\.tgfoid\s*=\s*pg_catalog\.to_regprocedure/iu);
  assert.match(sql, /trigger_row\.tgtype\s*=\s*23/iu);
  assert.match(sql, /trigger_row\.tgenabled\s*<>\s*'D'/iu);
  assert.doesNotMatch(sql, /pg_catalog\.(?:nullif|coalesce)\s*\(/iu);
  assert.doesNotMatch(sql, /drop\s+trigger|create\s+trigger|update\s+public\.|insert\s+into\s+public\.|delete\s+from\s+public\./iu);
  assert.doesNotMatch(sql, /thumbnail|image|product_title|model|brand|category|keyword/iu);
});
