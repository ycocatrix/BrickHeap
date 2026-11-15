#!/usr/bin/env bash
# Runs the SQL tests of public.sync on a throwaway local PostgreSQL cluster (no Docker, no remote call):
#   00_stub.sql (roles + auth stub) → migration 1 → migration 2 → 99_test.sql (asserted scenarios §6.1.1).
# Exit code ≠ 0 on any failure. The cluster lives in a temporary directory removed on exit.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PG_BIN="${PG_BIN:-}"
if [ -z "$PG_BIN" ]; then
  if command -v initdb >/dev/null 2>&1; then PG_BIN="$(dirname "$(command -v initdb)")"; else PG_BIN=/usr/local/bin; fi
fi
for tool in initdb pg_ctl psql; do
  [ -x "$PG_BIN/$tool" ] || { echo "run.sh: $PG_BIN/$tool not found (set PG_BIN)" >&2; exit 2; }
done

PORT="${PGTEST_PORT:-54329}"
# Short path: the Unix socket path must stay under ~100 characters.
WORK="$(mktemp -d /tmp/bhpg.XXXXXX)"
DATA="$WORK/data"

cleanup() {
  "$PG_BIN/pg_ctl" -D "$DATA" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

"$PG_BIN/initdb" -D "$DATA" -A trust -U postgres -E UTF8 --no-locale >"$WORK/initdb.log" 2>&1 \
  || { cat "$WORK/initdb.log" >&2; exit 1; }
"$PG_BIN/pg_ctl" -D "$DATA" -l "$WORK/server.log" -w \
  -o "-k $WORK -p $PORT -c listen_addresses=''" start >/dev/null \
  || { cat "$WORK/server.log" >&2; exit 1; }

run_sql() {
  echo "== $1"
  "$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 -h "$WORK" -p "$PORT" -U postgres -d postgres -f "$1"
}

run_sql "$ROOT/supabase/tests/00_stub.sql"
run_sql "$ROOT/supabase/migrations/20261114000000_init.sql"
run_sql "$ROOT/supabase/migrations/20261115000000_sync_catalog.sql"
run_sql "$ROOT/supabase/tests/99_test.sql"
echo "run.sh: OK"
