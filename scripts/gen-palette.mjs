#!/usr/bin/env node
// Generates src/data/seed/palette.json from the Rebrickable API (two read-only GET calls).
//
// Usage (the key is read from the environment and never printed):
//   set -a; . ./.env; set +a; node scripts/gen-palette.mjs
//
// Output: { "generatedAt": ISO, "colors": CatalogColor[], "categories": CatalogCategory[] } and nothing else.
// Colour ids -1 (Unknown) and 9999 ([No Color/Any Color]) are skipped; bricklinkId = external_ids.BrickLink.ext_ids[0] ?? null.
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RB = 'https://rebrickable.com/api/v3/lego';
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data', 'seed', 'palette.json');

const key = process.env.REBRICKABLE_API_KEY;
if (!key) {
  console.error('REBRICKABLE_API_KEY is not set in the environment.');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path) {
  const r = await fetch(RB + path, { headers: { Authorization: `key ${key}`, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`GET ${path} → HTTP ${r.status}`);
  return r.json();
}

const hex6 = (h) => String(h ?? '').replace(/^#/, '').toUpperCase().padStart(6, '0').slice(0, 6);

const colorsJson = await get('/colors/?page_size=1000');
await sleep(1100); // Rebrickable ≈ 1 req/s
const catsJson = await get('/part_categories/?page_size=200');

const colors = (colorsJson.results ?? [])
  .filter((c) => typeof c.id === 'number' && c.id !== -1 && c.id !== 9999)
  .map((c) => {
    const bl = c.external_ids?.BrickLink?.ext_ids?.[0];
    return {
      colorId: c.id,
      name: String(c.name),
      hex: hex6(c.rgb),
      isTrans: c.is_trans === true,
      bricklinkId: typeof bl === 'number' ? bl : null,
    };
  })
  .sort((a, b) => a.colorId - b.colorId);

const categories = (catsJson.results ?? [])
  .filter((c) => typeof c.id === 'number')
  .map((c) => ({ id: c.id, name: String(c.name) }))
  .sort((a, b) => a.id - b.id);

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), colors, categories }, null, 2) + '\n');
console.log(`palette.json: ${colors.length} colours, ${categories.length} categories`);
