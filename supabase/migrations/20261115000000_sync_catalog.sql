-- BrickHeap migration 2: explicit Data API grants, catalog caches, offline-first sync.

-- 1. Catalog caches: only the Edge Function (service_role) touches them -------
drop policy "read parts" on public.parts_cache;
drop policy "read colors" on public.colors_cache;

alter table public.parts_cache
  drop column category,
  drop column dims,
  add column part_cat_id int,
  add column bricklink_ids text[] not null default '{}',
  add column lego_ids text[] not null default '{}',
  add column print_of text,
  add column year_from int,
  add column year_to int,
  add column found boolean not null default true;          -- false = negative cache

alter table public.colors_cache
  add column is_trans boolean not null default false,
  add column bricklink_id int,
  add column fetched_at timestamptz not null default now();

create table public.part_categories_cache (id int primary key, name text not null);

create table public.bricklink_map_cache (                   -- Brickognize/BrickLink id -> Rebrickable part_num(s)
  bricklink_id text primary key,
  part_ids text[] not null default '{}',                    -- [primary, ...alternates]; empty = no match
  fetched_at timestamptz not null default now());

create table public.part_colors_cache (                     -- EX_12 element ids + coloured image
  part_id text not null, color_id int not null,
  element_ids text[] not null default '{}', image_url text, num_sets int,
  found boolean not null default true,
  fetched_at timestamptz not null default now(),
  primary key (part_id, color_id));

create table public.part_color_lists_cache (                -- marks "all colours of this part fetched" (op part_colors)
  part_id text primary key,
  fetched_at timestamptz not null default now());

create table public.part_color_sets_cache (                 -- EX_14, one row per Rebrickable page
  part_id text not null, color_id int not null, page int not null,
  total int not null, sets jsonb not null,
  fetched_at timestamptz not null default now(),
  primary key (part_id, color_id, page));

create table public.set_part_qty_cache (                    -- EX_14 quantity, filled on demand
  set_num text not null, part_id text not null, color_id int not null,
  quantity int not null,                                    -- 0 = the set does not contain it
  fetched_at timestamptz not null default now(),
  primary key (set_num, part_id, color_id));

alter table public.part_categories_cache enable row level security;
alter table public.bricklink_map_cache enable row level security;
alter table public.part_colors_cache enable row level security;
alter table public.part_color_lists_cache enable row level security;
alter table public.part_color_sets_cache enable row level security;
alter table public.set_part_qty_cache enable row level security;

grant select, insert, update, delete on
  public.parts_cache, public.colors_cache, public.part_categories_cache, public.bricklink_map_cache,
  public.part_colors_cache, public.part_color_lists_cache, public.part_color_sets_cache, public.set_part_qty_cache
  to service_role;

-- 2. User data: natural key, quantity 0 = tombstone, writes only through sync() --
alter table public.lists
  add column updated_at timestamptz not null default now(),
  add column deleted_at timestamptz,
  add constraint lists_name_len check (char_length(name) between 1 and 60);

alter table public.inventory_items
  drop column id,                                           -- drops the surrogate PK
  drop constraint inventory_items_list_id_part_id_color_id_key,
  add primary key (list_id, part_id, color_id),
  drop constraint inventory_items_quantity_check,
  add constraint inventory_items_quantity_check check (quantity between 0 and 100000),
  add constraint inventory_items_part_len check (char_length(part_id) between 1 and 40);

create index lists_user_updated_idx on public.lists (user_id, updated_at);
create index inventory_items_user_updated_idx on public.inventory_items (user_id, updated_at);

create table public.sync_devices (                          -- idempotency: last batch applied per device
  user_id uuid not null references auth.users on delete cascade,
  device_id uuid not null,
  last_batch_id uuid not null,
  last_sync_at timestamptz not null default now(),
  primary key (user_id, device_id));
alter table public.sync_devices enable row level security;  -- no policy, no grant: sync() only

drop policy "own lists" on public.lists;
drop policy "own items" on public.inventory_items;
create policy lists_select_own on public.lists for select to authenticated
  using (user_id = (select auth.uid()));
create policy items_select_own on public.inventory_items for select to authenticated
  using (user_id = (select auth.uid()));
grant select on public.lists, public.inventory_items to authenticated;

-- 3. One round trip: push local changes (list upserts + quantity deltas), pull what changed.
create function public.sync(
  p_device_id uuid, p_batch_id uuid, p_since timestamptz default null,
  p_lists jsonb default '[]', p_items jsonb default '[]')
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_now timestamptz;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if jsonb_array_length(p_lists) > 200 or jsonb_array_length(p_items) > 5000 then
    raise exception 'batch too large' using errcode = '54000';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 0));  -- one sync at a time per user
  v_now := clock_timestamp();

  if not exists (select 1 from public.sync_devices
                 where user_id = v_uid and device_id = p_device_id and last_batch_id = p_batch_id) then
    -- lists: last push wins on the name, a delete is final
    insert into public.lists as t (id, user_id, name, created_at, updated_at, deleted_at)
    select l.id, v_uid, l.name, coalesce(l.created_at, v_now), v_now,
           case when coalesce(l.deleted, false) then v_now end
    from jsonb_to_recordset(p_lists) as l(id uuid, name text, created_at timestamptz, deleted boolean)
    on conflict (id) do update
      set name = excluded.name, updated_at = v_now,
          deleted_at = coalesce(t.deleted_at, excluded.deleted_at)
      where t.user_id = v_uid;

    -- deleting a list zeroes its items so other devices drop them
    update public.inventory_items i set quantity = 0, updated_at = v_now
    from public.lists l
    where l.id = i.list_id and l.user_id = v_uid and l.deleted_at = v_now and i.quantity > 0;

    -- items: RG_08 = add the delta; never below 0 (0 = tombstone, RG_10)
    with d as (
      select x.list_id, x.part_id, x.color_id, sum(x.delta)::int as delta
      from jsonb_to_recordset(p_items) as x(list_id uuid, part_id text, color_id int, delta int)
      join public.lists l on l.id = x.list_id and l.user_id = v_uid and l.deleted_at is null
      group by 1, 2, 3
      having sum(x.delta) <> 0
    ), upd as (
      update public.inventory_items i
      set quantity = least(greatest(i.quantity + d.delta, 0), 100000), updated_at = v_now
      from d
      where i.list_id = d.list_id and i.part_id = d.part_id and i.color_id = d.color_id
    )
    insert into public.inventory_items (user_id, list_id, part_id, color_id, quantity, updated_at)
    select v_uid, d.list_id, d.part_id, d.color_id, least(d.delta, 100000), v_now
    from d
    where d.delta > 0 and not exists (
      select 1 from public.inventory_items e
      where e.list_id = d.list_id and e.part_id = d.part_id and e.color_id = d.color_id);

    insert into public.sync_devices as s (user_id, device_id, last_batch_id, last_sync_at)
    values (v_uid, p_device_id, p_batch_id, v_now)
    on conflict (user_id, device_id) do update
      set last_batch_id = excluded.last_batch_id, last_sync_at = v_now;

    delete from public.inventory_items                       -- purge old tombstones
    where user_id = v_uid and quantity = 0 and updated_at < v_now - interval '90 days';
  end if;

  return jsonb_build_object(
    'server_time', v_now,
    'lists', (select coalesce(jsonb_agg(jsonb_build_object(
                'id', id, 'name', name, 'created_at', created_at, 'deleted', deleted_at is not null)), '[]'::jsonb)
              from public.lists
              where user_id = v_uid and (p_since is null or updated_at > p_since)),
    'items', (select coalesce(jsonb_agg(jsonb_build_object(
                'list_id', list_id, 'part_id', part_id, 'color_id', color_id, 'quantity', quantity)), '[]'::jsonb)
              from public.inventory_items
              where user_id = v_uid and (p_since is null and quantity > 0 or updated_at > p_since)));
end;
$$;

revoke all on function public.sync(uuid, uuid, timestamptz, jsonb, jsonb) from public, anon;
grant execute on function public.sync(uuid, uuid, timestamptz, jsonb, jsonb) to authenticated;
