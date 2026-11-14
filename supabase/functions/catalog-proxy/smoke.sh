#!/usr/bin/env bash
# Post-deploy smoke checks for catalog-proxy (§6.2). Run AFTER `supabase functions deploy catalog-proxy` (user action U3).
#
#   set -a; . ./.env; set +a; bash supabase/functions/catalog-proxy/smoke.sh
#
# Reads EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY from the environment. Prints only the HTTP
# status and the JSON shape (top-level keys / statuses), never the key and never full bodies.
# Requires curl and node (used to summarise JSON).
set -euo pipefail

URL="${EXPO_PUBLIC_SUPABASE_URL:?EXPO_PUBLIC_SUPABASE_URL is not set}"
KEY="${EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY:?EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY is not set (the legacy anon key is rejected)}"
ENDPOINT="$URL/functions/v1/catalog-proxy"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

shape() {
  node -e '
    const fs = require("fs");
    let j; try { j = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { console.log("  (not JSON)"); process.exit(0); }
    const keys = Object.keys(j);
    console.log("  keys:", keys.join(", "));
    if (j.parts && typeof j.parts === "object") {
      for (const [id, v] of Object.entries(j.parts)) {
        if (Array.isArray(v)) console.log(`  ${id}: ${v.length} colour(s)`);
        else console.log(`  ${id}: ${v.status}${v.part ? " -> " + v.part.part_id : ""}`);
      }
    }
    if (j.part_color) console.log("  part_color.found:", j.part_color.found, "· sets:", j.sets ? `${j.sets.sets.length}/${j.sets.total}` : null);
    if ("quantity" in j) console.log("  quantity:", j.quantity);
    if (j.colors) console.log("  colors:", j.colors.length, "· categories:", (j.categories || []).length);
    if (j.error) console.log("  error:", j.error, j.field || "");
  ' "$TMP"
}

call() { # $1 = label, $2 = JSON body, $3 = optional method
  local status
  status=$(curl -sS -o "$TMP" -w '%{http_code}' -X "${3:-POST}" "$ENDPOINT" \
    -H "apikey: $KEY" -H 'Content-Type: application/json' ${2:+--data "$2"})
  echo "$1 → HTTP $status"
  shape
}

call "parts (bricklink)"   '{"op":"parts","id_type":"bricklink","ids":["3001","3062","4073","3001special"]}'
# expected: 200; 3001 found -> 3001, 3062 found -> 3062b (or pending), 4073 found -> 6141 (or pending), 3001special not_found
call "parts (rebrickable)" '{"op":"parts","id_type":"rebrickable","ids":["3001","3020","zz-none"]}'
# expected: 200; zz-none not_found
call "part_colors"         '{"op":"part_colors","part_ids":["3001"]}'
call "detail"              '{"op":"detail","part_id":"3001","color_id":4,"page":1}'
# expected: 200; part_color.found true, sets n/total
call "set_qty"             '{"op":"set_qty","set_num":"10018-1","part_id":"3001","color_id":4}'
call "palette"             '{"op":"palette"}'
# expected: 200; ≥ 270 colours, 76 categories
call "bad request"         '{"op":"parts","id_type":"bricklink","ids":["bad id!"]}'
# expected: 400 bad_request ids
call "wrong method"        '' GET
# expected: 405 method_not_allowed

echo "without key →"
curl -sS -o /dev/null -w '  HTTP %{http_code} (expected 401)\n' -X POST "$ENDPOINT" -H 'Content-Type: application/json' --data '{"op":"palette"}'
