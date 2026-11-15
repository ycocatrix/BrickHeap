-- Asserted tests of public.sync (migration 20261115000000_sync_catalog.sql), run by supabase/tests/run.sh after
-- 00_stub.sql and both migrations. Every scenario of the plan's table §6.1.1 is asserted here with the same users,
-- devices, batch ids, deltas and expected values as src/domain/sync/scenarios.ts (Jest runs the same table against
-- an in-memory fake). Any unexpected result raises '<scenario id>: …' and psql stops (ON_ERROR_STOP).
\set ON_ERROR_STOP on
set client_min_messages = warning;

-- ---------- helpers (session-local, superuser) ----------
-- U = …0a, V = …0b · devices A = 1111…, B = 2222…, C = 3333… · list L = 9999…0001
create function pg_temp.reset_users() returns void language plpgsql as $$
begin
  truncate auth.users cascade;                         -- lists, inventory_items, sync_devices cascade
  insert into auth.users (id) values ('00000000-0000-0000-0000-00000000000a'), ('00000000-0000-0000-0000-00000000000b');
end $$;

-- One `sync` call as user p_as (null = anon), with the API role switched for the call only.
create function pg_temp.push(p_as uuid, p_device uuid, p_batch uuid, p_since timestamptz,
                             p_lists jsonb default '[]', p_items jsonb default '[]')
returns jsonb language plpgsql as $$
declare r jsonb;
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_as::text, ''), true);
  perform set_config('role', case when p_as is null then 'anon' else 'authenticated' end, true);
  r := public.sync(p_device, p_batch, p_since, p_lists, p_items);
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claim.sub', '', true);
  return r;
end $$;

create function pg_temp.q(p_list uuid, p_part text, p_color int) returns int language sql as $$
  select quantity from public.inventory_items where list_id = p_list and part_id = p_part and color_id = p_color $$;

create function pg_temp.items_of(r jsonb) returns jsonb language sql as $$
  select coalesce(jsonb_agg(jsonb_build_object('part', e->>'part_id', 'color', (e->>'color_id')::int,
                                               'quantity', (e->>'quantity')::int)
                            order by e->>'part_id', (e->>'color_id')::int), '[]'::jsonb)
  from jsonb_array_elements(r->'items') e $$;

create function pg_temp.lists_of(r jsonb) returns jsonb language sql as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', e->>'id', 'deleted', (e->>'deleted')::boolean)
                            order by e->>'id'), '[]'::jsonb)
  from jsonb_array_elements(r->'lists') e $$;

create function pg_temp.expect(p_ok boolean, p_msg text) returns void language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception '%', p_msg; end if;
end $$;

-- S1 create: U/A creates list L, +3 (3001, 4) → q = 3; response has L and the item
do $$ begin perform pg_temp.reset_users(); end $$;
do $$
declare r jsonb;
begin
  r := pg_temp.push('00000000-0000-0000-0000-00000000000a', '11111111-0000-0000-0000-000000000001',
    'aaaaaaaa-0000-0000-0000-000000000001', null,
    '[{"id":"99999999-0000-0000-0000-000000000001","name":"Vrac Salon","created_at":"2026-11-14T20:00:00Z","deleted":false}]',
    '[{"list_id":"99999999-0000-0000-0000-000000000001","part_id":"3001","color_id":4,"delta":3}]');
  perform pg_temp.expect(pg_temp.q('99999999-0000-0000-0000-000000000001', '3001', 4) = 3, 'S1: quantity is not 3');
  perform pg_temp.expect(pg_temp.lists_of(r) = '[{"id":"99999999-0000-0000-0000-000000000001","deleted":false}]',
    'S1: response lists ' || pg_temp.lists_of(r)::text);
  perform pg_temp.expect(pg_temp.items_of(r) = '[{"part":"3001","color":4,"quantity":3}]',
    'S1: response items ' || pg_temp.items_of(r)::text);
  perform pg_temp.expect(r->>'server_time' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+[+-]\d{2}:\d{2}$',
    'S1: server_time is not timestamptz text with microseconds: ' || (r->>'server_time'));
end $$;

-- S2 replay: S1, then the same batch id again → q = 3 (not 6); response still returned
do $$ begin perform pg_temp.reset_users(); end $$;
do $$
declare r jsonb;
begin
  for i in 1..2 loop
    r := pg_temp.push('00000000-0000-0000-0000-00000000000a', '11111111-0000-0000-0000-000000000001',
      'aaaaaaaa-0000-0000-0000-000000000001', null,
      '[{"id":"99999999-0000-0000-0000-000000000001","name":"Vrac Salon","created_at":"2026-11-14T20:00:00Z","deleted":false}]',
      '[{"list_id":"99999999-0000-0000-0000-000000000001","part_id":"3001","color_id":4,"delta":3}]');
  end loop;
  perform pg_temp.expect(pg_temp.q('99999999-0000-0000-0000-000000000001', '3001', 4) = 3, 'S2: replay applied twice');
  perform pg_temp.expect(pg_temp.lists_of(r) = '[{"id":"99999999-0000-0000-0000-000000000001","deleted":false}]',
    'S2: replay response lists ' || pg_temp.lists_of(r)::text);
  perform pg_temp.expect(pg_temp.items_of(r) = '[{"part":"3001","color":4,"quantity":3}]',
    'S2: replay response items ' || pg_temp.items_of(r)::text);
end $$;

-- Shared prefix of S3, S9, S13: S1; A +2 (batch a2); B −7 (batch b1)
create function pg_temp.s3_steps() returns void language plpgsql as $$
begin
  perform pg_temp.push('00000000-0000-0000-0000-00000000000a', '11111111-0000-0000-0000-000000000001',
    'aaaaaaaa-0000-0000-0000-000000000001', null,
    '[{"id":"99999999-0000-0000-0000-000000000001","name":"Vrac Salon","created_at":"2026-11-14T20:00:00Z","deleted":false}]',
    '[{"list_id":"99999999-0000-0000-0000-000000000001","part_id":"3001","color_id":4,"delta":3}]');
  perform pg_temp.push('00000000-0000-0000-0000-00000000000a', '11111111-0000-0000-0000-000000000001',
    'aaaaaaaa-0000-0000-0000-000000000002', null, '[]',
    '[{"list_id":"99999999-0000-0000-0000-000000000001","part_id":"3001","color_id":4,"delta":2}]');
  perform pg_temp.push('00000000-0000-0000-0000-00000000000a', '22222222-0000-0000-0000-000000000002',
    'bbbbbbbb-0000-0000-0000-000000000001', null, '[]',
    '[{"list_id":"99999999-0000-0000-0000-000000000001","part_id":"3001","color_id":4,"delta":-7}]');
end $$;

-- S3 concurrent → q = 0 (floored, not −2), row kept as tombstone
do $$ begin perform pg_temp.reset_users(); end $$;
do $$
begin
  perform pg_temp.s3_steps();
  perform pg_temp.expect(pg_temp.q('99999999-0000-0000-0000-000000000001', '3001', 4) = 0,
    'S3: quantity is ' || coalesce(pg_temp.q('99999999-0000-0000-0000-000000000001', '3001', 4)::text, 'absent') || ', expected tombstone 0');
end $$;

-- S4 sum: U/A +3 and U/B +2 on a new key, separate batches → q = 5
do $$ begin perform pg_temp.reset_users(); end $$;
do $$
begin
  perform pg_temp.push('00000000-0000-0000-0000-00000000000a', '11111111-0000-0000-0000-000000000001',
    'aaaaaaaa-0000-0000-0000-000000000001', null,
    '[{"id":"99999999-0000-0000-0000-000000000001","name":"Vrac Salon","created_at":"2026-11-14T20:00:00Z","deleted":false}]',
    '[{"list_id":"99999999-0000-0000-0000-000000000001","part_id":"3020","color_id":0,"delta":3}]');
  perform pg_temp.push('00000000-0000-0000-0000-00000000000a', '22222222-0000-0000-0000-000000000002',
    'bbbbbbbb-0000-0000-0000-000000000001', null, '[]',
    '[{"list_id":"99999999-0000-0000-0000-000000000001","part_id":"3020","color_id":0,"delta":2}]');
  perform pg_temp.expect(pg_temp.q('99999999-0000-0000-0000-000000000001', '3020', 0) = 5, 'S4: quantity is not 5');
end $$;

-- S5 cap: +99 999 then +10 → q = 100 000
do $$ begin perform pg_temp.reset_users(); end $$;
do $$
begin
  perform pg_temp.push('00000000-0000-0000-0000-00000000000a', '11111111-0000-0000-0000-000000000001',
    'aaaaaaaa-0000-0000-0000-000000000001', null,
    '[{"id":"99999999-0000-0000-0000-000000000001","name":"Vrac Salon","created_at":"2026-11-14T20:00:00Z","deleted":false}]',
    '[{"list_id":"99999999-0000-0000-0000-000000000001","part_id":"3001","color_id":4,"delta":99999}]');
  perform pg_temp.push('00000000-0000-0000-0000-00000000000a', '11111111-0000-0000-0000-000000000001',
    'aaaaaaaa-0000-0000-0000-000000000002', null, '[]',
    '[{"list_id":"99999999-0000-0000-0000-000000000001","part_id":"3001","color_id":4,"delta":10}]');
  perform pg_temp.expect(pg_temp.q('99999999-0000-0000-0000-000000000001', '3001', 4) = 100000, 'S5: quantity is not capped at 100000');
end $$;

-- Shared prefix of S6, S7: S1; A sends L deleted (batch a2); C full pull (batch c1). Returns the full pull.
create function pg_temp.s6_steps() returns jsonb language plpgsql as $$
begin
  perform pg_temp.push('00000000-0000-0000-0000-00000000000a', '11111111-0000-0000-0000-000000000001',
    'aaaaaaaa-0000-0000-0000-000000000001', null,
    '[{"id":"99999999-0000-0000-0000-000000000001","name":"Vrac Salon","created_at":"2026-11-14T20:00:00Z","deleted":false}]',
    '[{"list_id":"99999999-0000-0000-0000-000000000001","part_id":"3001","color_id":4,"delta":3}]');
  perform pg_temp.push('00000000-0000-0000-0000-00000000000a', '11111111-0000-0000-0000-000000000001',
    'aaaaaaaa-0000-0000-0000-000000000002', null,
    '[{"id":"99999999-0000-0000-0000-000000000001","name":"Vrac Salon","created_at":"2026-11-14T20:00:00Z","deleted":true}]');
  return pg_temp.push('00000000-0000-0000-0000-00000000000a', '33333333-0000-0000-0000-000000000003',
    'cccccccc-0000-0000-0000-000000000001', null);
end $$;

-- S6 delete list → L.deleted_at set; item q = 0; full pull returns L with deleted true and no item
do $$ begin perform pg_temp.reset_users(); end $$;
do $$
declare r jsonb;
begin
  r := pg_temp.s6_steps();
  perform pg_temp.expect((select deleted_at is not null from public.lists where id = '99999999-0000-0000-0000-000000000001'),
    'S6: deleted_at not set');
  perform pg_temp.expect(pg_temp.q('99999999-0000-0000-0000-000000000001', '3001', 4) = 0, 'S6: item not zeroed');
  perform pg_temp.expect(pg_temp.lists_of(r) = '[{"id":"99999999-0000-0000-0000-000000000001","deleted":true}]',
    'S6: full pull lists ' || pg_temp.lists_of(r)::text);
  perform pg_temp.expect(pg_temp.items_of(r) = '[]', 'S6: full pull items ' || pg_temp.items_of(r)::text);
end $$;

-- S7 delta on deleted list: S6; B +1 on L → ignored: q = 0, no error
do $$ begin perform pg_temp.reset_users(); end $$;
do $$
begin
  perform pg_temp.s6_steps();
  perform pg_temp.push('00000000-0000-0000-0000-00000000000a', '22222222-0000-0000-0000-000000000002',
    'bbbbbbbb-0000-0000-0000-000000000001', null, '[]',
    '[{"list_id":"99999999-0000-0000-0000-000000000001","part_id":"3001","color_id":4,"delta":1}]');
  perform pg_temp.expect(pg_temp.q('99999999-0000-0000-0000-000000000001', '3001', 4) = 0, 'S7: delta applied on a deleted list');
end $$;

-- S8 foreign list: U creates L; V sends +1 on L and a rename of L → U's item and name unchanged; V gets an empty success
do $$ begin perform pg_temp.reset_users(); end $$;
do $$
declare r jsonb;
begin
  perform pg_temp.push('00000000-0000-0000-0000-00000000000a', '11111111-0000-0000-0000-000000000001',
    'aaaaaaaa-0000-0000-0000-000000000001', null,
    '[{"id":"99999999-0000-0000-0000-000000000001","name":"Vrac Salon","created_at":"2026-11-14T20:00:00Z","deleted":false}]',
    '[{"list_id":"99999999-0000-0000-0000-000000000001","part_id":"3001","color_id":4,"delta":3}]');
  r := pg_temp.push('00000000-0000-0000-0000-00000000000b', '33333333-0000-0000-0000-000000000003',
    'cccccccc-0000-0000-0000-000000000001', null,
    '[{"id":"99999999-0000-0000-0000-000000000001","name":"HACK","created_at":null,"deleted":false}]',
    '[{"list_id":"99999999-0000-0000-0000-000000000001","part_id":"3001","color_id":4,"delta":1}]');
  perform pg_temp.expect(pg_temp.q('99999999-0000-0000-0000-000000000001', '3001', 4) = 3, 'S8: foreign delta applied');
  perform pg_temp.expect((select name = 'Vrac Salon' and deleted_at is null and user_id = '00000000-0000-0000-0000-00000000000a'
                          from public.lists where id = '99999999-0000-0000-0000-000000000001'), 'S8: foreign rename applied');
  perform pg_temp.expect(pg_temp.lists_of(r) = '[]' and pg_temp.items_of(r) = '[]', 'S8: V response not empty: ' || r::text);
end $$;

-- S9 full pull: S3 (q 0) + another key q 2; full pull → only the q 2 item returned
do $$ begin perform pg_temp.reset_users(); end $$;
do $$
declare r jsonb;
begin
  perform pg_temp.s3_steps();
  perform pg_temp.push('00000000-0000-0000-0000-00000000000a', '11111111-0000-0000-0000-000000000001',
    'aaaaaaaa-0000-0000-0000-000000000003', null, '[]',
    '[{"list_id":"99999999-0000-0000-0000-000000000001","part_id":"3020","color_id":0,"delta":2}]');
  r := pg_temp.push('00000000-0000-0000-0000-00000000000a', '33333333-0000-0000-0000-000000000003',
    'cccccccc-0000-0000-0000-000000000001', null);
  perform pg_temp.expect(pg_temp.items_of(r) = '[{"part":"3020","color":0,"quantity":2}]',
    'S9: full pull items ' || pg_temp.items_of(r)::text);
  perform pg_temp.expect(pg_temp.lists_of(r) = '[{"id":"99999999-0000-0000-0000-000000000001","deleted":false}]',
    'S9: full pull lists ' || pg_temp.lists_of(r)::text);
end $$;

-- S10 incremental pull: A creates L with two keys; B +1 on one key with p_since = A's server_time → only that row
do $$ begin perform pg_temp.reset_users(); end $$;
do $$
declare r1 jsonb; r2 jsonb;
begin
  r1 := pg_temp.push('00000000-0000-0000-0000-00000000000a', '11111111-0000-0000-0000-000000000001',
    'aaaaaaaa-0000-0000-0000-000000000001', null,
    '[{"id":"99999999-0000-0000-0000-000000000001","name":"Vrac Salon","created_at":"2026-11-14T20:00:00Z","deleted":false}]',
    '[{"list_id":"99999999-0000-0000-0000-000000000001","part_id":"3001","color_id":4,"delta":3},
      {"list_id":"99999999-0000-0000-0000-000000000001","part_id":"3020","color_id":0,"delta":1}]');
  r2 := pg_temp.push('00000000-0000-0000-0000-00000000000a', '22222222-0000-0000-0000-000000000002',
    'bbbbbbbb-0000-0000-0000-000000000001', (r1->>'server_time')::timestamptz, '[]',
    '[{"list_id":"99999999-0000-0000-0000-000000000001","part_id":"3001","color_id":4,"delta":1}]');
  perform pg_temp.expect(pg_temp.items_of(r2) = '[{"part":"3001","color":4,"quantity":4}]',
    'S10: incremental items ' || pg_temp.items_of(r2)::text);
  perform pg_temp.expect(pg_temp.lists_of(r2) = '[]', 'S10: incremental lists ' || pg_temp.lists_of(r2)::text);
end $$;

-- S11 limits: 201 lists or 5001 deltas → SQLSTATE 54000, nothing applied
do $$ begin perform pg_temp.reset_users(); end $$;
do $$
begin
  begin
    perform pg_temp.push('00000000-0000-0000-0000-00000000000a', '11111111-0000-0000-0000-000000000001',
      'aaaaaaaa-0000-0000-0000-000000000001', null,
      (select jsonb_agg(jsonb_build_object('id', '99999999-0000-0000-0001-' || lpad(n::text, 12, '0'), 'name', 'L' || n,
                                           'created_at', null, 'deleted', false))
       from generate_series(1, 201) n));
    raise exception 'S11: 201 lists accepted';
  exception when sqlstate '54000' then null;
  end;
  begin
    perform pg_temp.push('00000000-0000-0000-0000-00000000000a', '11111111-0000-0000-0000-000000000001',
      'aaaaaaaa-0000-0000-0000-000000000002', null,
      '[{"id":"99999999-0000-0000-0000-000000000001","name":"Vrac Salon","created_at":"2026-11-14T20:00:00Z","deleted":false}]',
      (select jsonb_agg(jsonb_build_object('list_id', '99999999-0000-0000-0000-000000000001', 'part_id', 'p' || n,
                                           'color_id', 0, 'delta', 1))
       from generate_series(1, 5001) n));
    raise exception 'S11: 5001 deltas accepted';
  exception when sqlstate '54000' then null;
  end;
  perform pg_temp.expect((select count(*) from public.lists) = 0 and (select count(*) from public.inventory_items) = 0
                         and (select count(*) from public.sync_devices) = 0, 'S11: rows written by a rejected batch');
end $$;

-- S12 invalid row: a 61-character list name → 23514, whole batch rolled back, device row not updated; the same
-- batch id resent after fixing is applied
do $$ begin perform pg_temp.reset_users(); end $$;
do $$
begin
  begin
    perform pg_temp.push('00000000-0000-0000-0000-00000000000a', '11111111-0000-0000-0000-000000000001',
      'aaaaaaaa-0000-0000-0000-000000000001', null,
      jsonb_build_array(jsonb_build_object('id', '99999999-0000-0000-0000-000000000001', 'name', repeat('x', 61),
                                           'created_at', '2026-11-14T20:00:00Z', 'deleted', false)),
      '[{"list_id":"99999999-0000-0000-0000-000000000001","part_id":"3001","color_id":4,"delta":3}]');
    raise exception 'S12: 61-character name accepted';
  exception when sqlstate '23514' then null;
  end;
  perform pg_temp.expect((select count(*) from public.lists) = 0 and (select count(*) from public.inventory_items) = 0,
    'S12: rejected batch not rolled back');
  perform pg_temp.expect((select count(*) from public.sync_devices) = 0, 'S12: device row updated by a rejected batch');
  perform pg_temp.push('00000000-0000-0000-0000-00000000000a', '11111111-0000-0000-0000-000000000001',
    'aaaaaaaa-0000-0000-0000-000000000001', null,
    jsonb_build_array(jsonb_build_object('id', '99999999-0000-0000-0000-000000000001', 'name', repeat('x', 60),
                                         'created_at', '2026-11-14T20:00:00Z', 'deleted', false)),
    '[{"list_id":"99999999-0000-0000-0000-000000000001","part_id":"3001","color_id":4,"delta":3}]');
  perform pg_temp.expect(pg_temp.q('99999999-0000-0000-0000-000000000001', '3001', 4) = 3, 'S12: fixed resend not applied');
  perform pg_temp.expect((select name = repeat('x', 60) from public.lists where id = '99999999-0000-0000-0000-000000000001'),
    'S12: fixed name not stored');
  perform pg_temp.expect((select last_batch_id = 'aaaaaaaa-0000-0000-0000-000000000001' from public.sync_devices
                          where user_id = '00000000-0000-0000-0000-00000000000a'
                            and device_id = '11111111-0000-0000-0000-000000000001'), 'S12: device batch not recorded');
end $$;

-- S13 purge: a tombstone with updated_at 91 days ago, then any push → tombstone deleted
do $$ begin perform pg_temp.reset_users(); end $$;
do $$
begin
  perform pg_temp.s3_steps();
  update public.inventory_items set updated_at = now() - interval '91 days'
  where list_id = '99999999-0000-0000-0000-000000000001' and part_id = '3001' and color_id = 4;
  perform pg_temp.push('00000000-0000-0000-0000-00000000000a', '33333333-0000-0000-0000-000000000003',
    'cccccccc-0000-0000-0000-000000000001', null);
  perform pg_temp.expect(pg_temp.q('99999999-0000-0000-0000-000000000001', '3001', 4) is null, 'S13: tombstone not purged');
end $$;

-- S14 anon: sync as anon → permission denied
do $$ begin perform pg_temp.reset_users(); end $$;
do $$
begin
  begin
    perform pg_temp.push(null, '11111111-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', null,
      '[{"id":"99999999-0000-0000-0000-000000000001","name":"Vrac Salon","created_at":"2026-11-14T20:00:00Z","deleted":false}]');
    raise exception 'S14: anon could execute sync';
  exception when insufficient_privilege then null;
  end;
  perform pg_temp.expect((select count(*) from public.lists) = 0, 'S14: anon call wrote rows');
end $$;

-- S15 cascade: delete auth user U → U's lists, items, sync_devices gone
do $$ begin perform pg_temp.reset_users(); end $$;
do $$
begin
  perform pg_temp.push('00000000-0000-0000-0000-00000000000a', '11111111-0000-0000-0000-000000000001',
    'aaaaaaaa-0000-0000-0000-000000000001', null,
    '[{"id":"99999999-0000-0000-0000-000000000001","name":"Vrac Salon","created_at":"2026-11-14T20:00:00Z","deleted":false}]',
    '[{"list_id":"99999999-0000-0000-0000-000000000001","part_id":"3001","color_id":4,"delta":3}]');
  delete from auth.users where id = '00000000-0000-0000-0000-00000000000a';
  perform pg_temp.expect((select count(*) from public.lists) = 0 and (select count(*) from public.inventory_items) = 0
                         and (select count(*) from public.sync_devices) = 0, 'S15: rows left after deleting the user');
end $$;

-- Extra checks (not in §6.1.1): writes only through sync(), RLS hides other users' rows, caches closed to clients.
do $$ begin perform pg_temp.reset_users(); end $$;
do $$
declare n int;
begin
  perform pg_temp.push('00000000-0000-0000-0000-00000000000a', '11111111-0000-0000-0000-000000000001',
    'aaaaaaaa-0000-0000-0000-000000000001', null,
    '[{"id":"99999999-0000-0000-0000-000000000001","name":"Vrac Salon","created_at":"2026-11-14T20:00:00Z","deleted":false}]',
    '[{"list_id":"99999999-0000-0000-0000-000000000001","part_id":"3001","color_id":4,"delta":3}]');
  begin
    perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', true);
    perform set_config('role', 'authenticated', true);
    update public.inventory_items set quantity = 999;
    raise exception 'X1: direct update allowed';
  exception when insufficient_privilege then null;
  end;
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', true);
  perform set_config('role', 'authenticated', true);
  select count(*) into n from public.inventory_items;
  perform set_config('role', 'none', true);
  perform pg_temp.expect(n = 1, 'X2: owner cannot read its own rows');
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', true);
  perform set_config('role', 'authenticated', true);
  select count(*) into n from public.inventory_items;
  perform set_config('role', 'none', true);
  perform pg_temp.expect(n = 0, 'X2: another user can read the rows');
  begin
    perform set_config('role', 'anon', true);
    perform count(*) from public.parts_cache;
    raise exception 'X3: anon can read parts_cache';
  exception when insufficient_privilege then null;
  end;
end $$;

\echo 'supabase/tests/99_test.sql: all sync scenarios passed'
