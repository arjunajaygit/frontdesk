#!/usr/bin/env bash
# PostgreSQL logical backup + restore verification for the ISOLATED production-like compose stack (synthetic data).
#   bash infrastructure/ops/backup-restore-verify.sh            # backup `frontdesk`, restore into frontdesk_restore_verify
# - Backup: pg_dump custom format as the OWNER role (all objects, data, ACLs/GRANTs, triggers). Written to
#   .local/backups/ (git-ignored, dir 0700, file 0600). Never uploaded anywhere.
# - Roles are CLUSTER objects and are NOT in pg_dump. A restore target must already have frontdesk_owner and
#   frontdesk_app provisioned (infrastructure/docker/initdb does this; on a managed host see DEPLOYMENT.md).
#   We deliberately do not use pg_dumpall --roles-only (it would copy password hashes into the backup file).
# - Database-level grants (CONNECT) are also not in a non --create dump; re-applied explicitly below.
# Secrets come from .env.production.local and are never printed.
set -euo pipefail
cd "$(dirname "$0")/../.."
PG=frontdesk-prod-postgres-1
SRC=frontdesk
DST=${RESTORE_DB:-frontdesk_restore_verify}
[[ "$DST" =~ ^frontdesk_restore_[a-z0-9_]+$ ]] || { echo "restore target must be frontdesk_restore_*"; exit 2; }
set -a; . ./.env.production.local; set +a
psql_as() { local user=$1 pw=$2 db=$3; shift 3; docker exec -i -e PGPASSWORD="$pw" "$PG" psql -h 127.0.0.1 -U "$user" -d "$db" -v ON_ERROR_STOP=1 -At "$@"; }
owner() { psql_as frontdesk_owner "$FRONTDESK_OWNER_PASSWORD" "$@"; }
boot() { psql_as frontdesk_bootstrap "$POSTGRES_BOOTSTRAP_PASSWORD" "$@"; }
app() { psql_as frontdesk_app "$FRONTDESK_APP_PASSWORD" "$@"; }

umask 077
mkdir -p .local/backups && chmod 700 .local/backups
OUT=.local/backups/frontdesk-$(date -u +%Y%m%dT%H%M%SZ).dump
t0=$(date +%s.%N 2>/dev/null || python3 -c 'import time;print(time.time())')
docker exec -e PGPASSWORD="$FRONTDESK_OWNER_PASSWORD" "$PG" pg_dump -h 127.0.0.1 -U frontdesk_owner -d "$SRC" -Fc -Z 6 > "$OUT"
t1=$(python3 -c 'import time;print(time.time())')
chmod 600 "$OUT"
echo "backup: $OUT size=$(stat -f %z "$OUT" 2>/dev/null || stat -c %s "$OUT") bytes mode=$(stat -f %Lp "$OUT" 2>/dev/null || stat -c %a "$OUT") pg_dump=$(docker exec $PG pg_dump --version | awk '{print $3}')"
echo "backup sha256: $(shasum -a 256 "$OUT" | cut -c1-64)"

# Fresh scratch target (only ever a frontdesk_restore_* name), owned by the owner role.
boot postgres -c "DROP DATABASE IF EXISTS $DST WITH (FORCE)" >/dev/null
boot postgres -c "CREATE DATABASE $DST OWNER frontdesk_owner" >/dev/null
boot postgres -c "REVOKE ALL ON DATABASE $DST FROM PUBLIC" -c "GRANT CONNECT ON DATABASE $DST TO frontdesk_app" >/dev/null
t2=$(python3 -c 'import time;print(time.time())')
docker exec -i -e PGPASSWORD="$FRONTDESK_OWNER_PASSWORD" "$PG" pg_restore -h 127.0.0.1 -U frontdesk_owner -d "$DST" --exit-on-error --single-transaction < "$OUT"
t3=$(python3 -c 'import time;print(time.time())')
python3 -c "print(f'timings: backup={float($t1)-float($t0):.2f}s restore={float($t3)-float($t2):.2f}s')"

COUNTS="SELECT string_agg(t || '=' || n, ' ' ORDER BY t) FROM (
  SELECT 'User' t, count(*) n FROM \"User\" UNION ALL SELECT 'Ticket', count(*) FROM \"Ticket\"
  UNION ALL SELECT 'Message', count(*) FROM \"Message\" UNION ALL SELECT 'SlaClock', count(*) FROM \"SlaClock\"
  UNION ALL SELECT 'audit_logs', count(*) FROM audit_logs UNION ALL SELECT 'breaches', count(*) FROM audit_logs WHERE action='SLA_BREACHED'
  UNION ALL SELECT 'Holiday', count(*) FROM \"Holiday\" UNION ALL SELECT 'migrations', count(*) FROM _prisma_migrations) x"
DIGEST="SELECT md5((SELECT string_agg(t::text,'|' ORDER BY id) FROM \"Ticket\" t) || (SELECT string_agg(s::text,'|' ORDER BY id) FROM \"SlaClock\" s)
  || (SELECT string_agg(a::text,'|' ORDER BY id) FROM audit_logs a) || (SELECT string_agg(m::text,'|' ORDER BY id) FROM \"Message\" m)
  || (SELECT string_agg(u.id || u.email || u.role || u.\"passwordHash\",'|' ORDER BY id) FROM \"User\" u))"
S_C=$(owner "$SRC" -c "$COUNTS"); D_C=$(owner "$DST" -c "$COUNTS")
S_D=$(owner "$SRC" -c "$DIGEST"); D_D=$(owner "$DST" -c "$DIGEST")
echo "source  counts: $S_C"; echo "restore counts: $D_C"
[[ "$S_C" == "$D_C" ]] && echo "PASS counts identical" || { echo "FAIL counts differ"; exit 1; }
[[ "$S_D" == "$D_D" ]] && echo "PASS content digest identical (tickets, clocks, audit, messages, users+roles)" || { echo "FAIL digest differs"; exit 1; }

TRIG="SELECT string_agg(tgname, ',' ORDER BY tgname) FROM pg_trigger WHERE tgrelid='audit_logs'::regclass AND NOT tgisinternal"
[[ "$(owner "$SRC" -c "$TRIG")" == "$(owner "$DST" -c "$TRIG")" ]] && echo "PASS audit triggers restored: $(owner "$DST" -c "$TRIG")" || { echo "FAIL triggers"; exit 1; }
[[ "$(owner "$DST" -c "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()")" == frontdesk_owner ]] && echo "PASS database owned by frontdesk_owner"
NOT_OWNED=$(owner "$DST" -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND pg_get_userbyid(c.relowner)<>'frontdesk_owner'")
[[ "$NOT_OWNED" == 0 ]] && echo "PASS every public relation owned by frontdesk_owner" || { echo "FAIL $NOT_OWNED relations not owner-owned"; exit 1; }

# Restricted runtime role on the RESTORED database: reads work, audit tampering and DDL fail.
app "$DST" -c "SELECT count(*) FROM \"Ticket\"" >/dev/null && echo "PASS frontdesk_app can read restored data"
expect_fail() { if app "$DST" -c "$1" >/dev/null 2>&1; then echo "FAIL runtime role could: $1"; exit 1; else echo "PASS runtime role denied: $2"; fi; }
expect_fail "UPDATE audit_logs SET action=action WHERE id=(SELECT id FROM audit_logs LIMIT 1)" "UPDATE audit_logs"
expect_fail "DELETE FROM audit_logs WHERE id=(SELECT id FROM audit_logs LIMIT 1)" "DELETE audit_logs"
expect_fail "TRUNCATE audit_logs" "TRUNCATE audit_logs"
expect_fail "CREATE TABLE x_restore_probe(id int)" "CREATE TABLE"
expect_fail "ALTER TABLE \"Ticket\" ADD COLUMN x int" "ALTER TABLE"
# The trusted owner is blocked by the append-only triggers too (except the documented owner boundary: it could drop them).
if owner "$DST" -c "UPDATE audit_logs SET action=action WHERE id=(SELECT id FROM audit_logs LIMIT 1)" >/dev/null 2>&1; then echo "FAIL owner UPDATE allowed"; exit 1; else echo "PASS append-only trigger blocks UPDATE even for the owner"; fi
echo "restore target: $DST (drop with: RESTORE_DB=$DST and DROP DATABASE as bootstrap, or rerun)"
