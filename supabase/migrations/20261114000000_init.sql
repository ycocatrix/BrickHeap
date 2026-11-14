-- BrickHeap initial schema. Apply with `supabase db push` on your own (free) project.
create table public.parts_cache (
  part_id text primary key, name text, category text, dims jsonb, image_url text,
  fetched_at timestamptz not null default now());
create table public.colors_cache (color_id int primary key, name text, hex text);

create table public.lists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null, created_at timestamptz not null default now());

create table public.inventory_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  list_id uuid not null references public.lists on delete cascade,
  part_id text not null, color_id int not null,
  quantity int not null check (quantity > 0),
  updated_at timestamptz not null default now(),
  unique (list_id, part_id, color_id));

alter table public.lists enable row level security;
alter table public.inventory_items enable row level security;
alter table public.parts_cache enable row level security;
alter table public.colors_cache enable row level security;

create policy "own lists" on public.lists for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own items" on public.inventory_items for all using (user_id = auth.uid()) with check (user_id = auth.uid());
-- Caches: public read; writes only via service_role (Edge Function), which bypasses RLS.
create policy "read parts" on public.parts_cache for select using (true);
create policy "read colors" on public.colors_cache for select using (true);
