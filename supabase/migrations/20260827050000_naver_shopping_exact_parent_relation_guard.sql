begin;

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

  related_catalog_id := pg_catalog.nullif(
    pg_catalog.btrim(new.item ->> 'relatedCatalogProductId'),
    ''
  );
  selected_catalog_id := pg_catalog.coalesce(
    pg_catalog.nullif(pg_catalog.btrim(new.item ->> 'catalogId'), ''),
    pg_catalog.nullif(pg_catalog.btrim(new.item ->> 'productId'), '')
  );

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

drop trigger if exists naver_shopping_exact_parent_relation_guard
on public.naver_rank_snapshots;

create trigger naver_shopping_exact_parent_relation_guard
before insert or update of tracker_id, item
on public.naver_rank_snapshots
for each row
execute function mi_internal.mi_guard_naver_shopping_exact_parent_snapshot();

commit;
