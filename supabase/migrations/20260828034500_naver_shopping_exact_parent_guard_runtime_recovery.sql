begin;

set local lock_timeout = '5s';

-- NULLIF and COALESCE are SQL expressions, not schema-qualified pg_proc
-- functions. Keep the applied guard migration immutable and replace only the
-- trigger function body so related-catalog snapshots can reach the exact-ID
-- checks instead of failing during expression resolution.
create or replace function mi_internal.mi_guard_naver_shopping_exact_parent_snapshot()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  target_product_id text;
  related_catalog_id text;
  selected_catalog_id text;
begin
  if new.item ->> 'trackingRankSource' is distinct from 'related_catalog' then
    return new;
  end if;

  select tracker.product_id
  into target_product_id
  from public.naver_rank_trackers as tracker
  where tracker.id = new.tracker_id;

  if not found then
    raise exception 'naver_shopping_exact_parent_relation_invalid'
      using errcode = 'check_violation';
  end if;

  related_catalog_id := pg_catalog.btrim(new.item ->> 'relatedCatalogProductId');
  if related_catalog_id = '' then
    related_catalog_id := null;
  end if;

  selected_catalog_id := pg_catalog.btrim(new.item ->> 'catalogId');
  if selected_catalog_id is null or selected_catalog_id = '' then
    selected_catalog_id := pg_catalog.btrim(new.item ->> 'productId');
  end if;
  if selected_catalog_id = '' then
    selected_catalog_id := null;
  end if;

  if target_product_id is null
    or pg_catalog.btrim(target_product_id) = ''
    or related_catalog_id is null
    or related_catalog_id = pg_catalog.btrim(target_product_id)
    or selected_catalog_id is distinct from related_catalog_id
    or new.item ->> 'relatedCatalogRelationBasis'
      is distinct from 'catalog_seller_product_id'
    or pg_catalog.jsonb_typeof(new.item -> 'catalogSellerProductIds')
      is distinct from 'array'
    or not (
      new.item -> 'catalogSellerProductIds'
        @> pg_catalog.jsonb_build_array(pg_catalog.btrim(target_product_id))
    ) then
    raise exception 'naver_shopping_exact_parent_relation_invalid'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

revoke all on function mi_internal.mi_guard_naver_shopping_exact_parent_snapshot()
from public, anon, authenticated, service_role;

do $$
declare
  function_definition text;
  exact_trigger_count integer;
begin
  select pg_catalog.pg_get_functiondef(procedure_row.oid)
  into function_definition
  from pg_catalog.pg_proc as procedure_row
  join pg_catalog.pg_namespace as namespace_row
    on namespace_row.oid = procedure_row.pronamespace
  where namespace_row.nspname = 'mi_internal'
    and procedure_row.proname = 'mi_guard_naver_shopping_exact_parent_snapshot'
    and procedure_row.pronargs = 0;

  if function_definition is null
    or pg_catalog.strpos(function_definition, 'pg_catalog.nullif') > 0
    or pg_catalog.strpos(function_definition, 'pg_catalog.coalesce') > 0 then
    raise exception 'naver_shopping_exact_parent_guard_runtime_recovery_invalid';
  end if;

  select count(*)
  into exact_trigger_count
  from pg_catalog.pg_trigger as trigger_row
  join pg_catalog.pg_class as relation_row
    on relation_row.oid = trigger_row.tgrelid
  join pg_catalog.pg_namespace as namespace_row
    on namespace_row.oid = relation_row.relnamespace
  where namespace_row.nspname = 'public'
    and relation_row.relname = 'naver_rank_snapshots'
    and trigger_row.tgname = 'naver_shopping_exact_parent_relation_guard'
    and trigger_row.tgfoid = pg_catalog.to_regprocedure(
      'mi_internal.mi_guard_naver_shopping_exact_parent_snapshot()'
    )
    and trigger_row.tgtype = 23
    and trigger_row.tgenabled <> 'D'
    and not trigger_row.tgisinternal;

  if exact_trigger_count <> 1 then
    raise exception 'naver_shopping_exact_parent_guard_trigger_invalid';
  end if;
end;
$$;

commit;
