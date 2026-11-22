#!/usr/bin/env bash
# Local rehearsal of the Supabase topology in a THROWAWAY container (no volume; removed at the end):
#  - container superuser plays `supabase_admin`; a NON-superuser `postgres` (CREATEROLE, CREATEDB) owns the database
#    and the `public` schema, exactly the position Supabase gives you;
#  - Supabase-style API roles (anon/authenticated/service_role) with DEFAULT PRIVILEGES FOR ROLE postgres on public;
#  - then: 01-provision.sql as postgres -> prisma migrate deploy as frontdesk_owner -> 02-post-migrate.sql -> 03-verify.sql -> explicit
#    seed -> the real API (built dist + web) as frontdesk_app -> startup privilege check, readiness, production smoke.
# Usage: bash infrastructure/deploy/supabase/rehearse-local.sh      (requires: npm run build; Docker)
set -euo pipefail
cd "$(dirname "$0")/../../.."
NAME=frontdesk-supa-rehearsal
PORT=55433
APP_PORT=8094
rand() { node -e "process.stdout.write(require('crypto').randomBytes(24).toString('base64url'))"; }
SUPER_PW=$(rand); ADMIN_PW=$(rand); OWNER_PW=$(rand); APP_PW=$(rand)
LABEL=supa-rehearsal
cleanup() { [[ -n "${APP_PID:-}" ]] && kill "$APP_PID" 2>/dev/null || true; docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -f ".local/credentials.$LABEL.json"; }
trap cleanup EXIT
docker run -d --name "$NAME" -e POSTGRES_USER=supabase_admin -e POSTGRES_PASSWORD="$SUPER_PW" -e POSTGRES_DB=postgres \
  -p 127.0.0.1:$PORT:5432 postgres:16.14-alpine >/dev/null
until docker exec "$NAME" pg_isready -U supabase_admin -d postgres >/dev/null 2>&1; do sleep 0.5; done
sleep 1
sq() { docker exec -i -e PGPASSWORD="$SUPER_PW" "$NAME" psql -h 127.0.0.1 -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -qAt "$@"; }
aq() { docker exec -i -e PGPASSWORD="$ADMIN_PW" "$NAME" psql -h 127.0.0.1 -U postgres -d postgres -v ON_ERROR_STOP=1 -qAt "$@"; }
sq -v admin_pw="$ADMIN_PW" <<'SQL'
CREATE ROLE postgres LOGIN NOSUPERUSER CREATEROLE CREATEDB PASSWORD :'admin_pw';
ALTER DATABASE postgres OWNER TO postgres;
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
SQL
echo "public schema owner: $(sq -c "SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='public'") ; postgres superuser: $(sq -c "SELECT rolsuper FROM pg_roles WHERE rolname='postgres'")"
docker exec -i "$NAME" sh -c 'cat > /tmp/p.sql' < infrastructure/deploy/supabase/01-provision.sql
docker exec -i "$NAME" sh -c 'cat > /tmp/m.sql' < infrastructure/deploy/supabase/02-post-migrate.sql
docker exec -i "$NAME" sh -c 'cat > /tmp/v.sql' < infrastructure/deploy/supabase/03-verify.sql
docker exec -e PGPASSWORD="$ADMIN_PW" "$NAME" psql -h 127.0.0.1 -U postgres -d postgres -qAt -v owner_pw="$OWNER_PW" -v app_pw="$APP_PW" -f /tmp/p.sql
OWNER_URL="postgresql://frontdesk_owner:${OWNER_PW}@127.0.0.1:$PORT/postgres"
APP_URL="postgresql://frontdesk_app:${APP_PW}@127.0.0.1:$PORT/postgres?connection_limit=5"
DATABASE_URL="$OWNER_URL" npx prisma migrate deploy 2>&1 | grep -E "migrations found|applied|No pending|Error" | head -8
docker exec -e PGPASSWORD="$ADMIN_PW" "$NAME" psql -h 127.0.0.1 -U postgres -d postgres -qAt -f /tmp/m.sql
echo "== 03-verify.sql"
docker exec -e PGPASSWORD="$ADMIN_PW" "$NAME" psql -h 127.0.0.1 -U postgres -d postgres -qAt -F ' | ' -f /tmp/v.sql | tee /tmp/frontdesk-supa-verify.txt
! grep -q '| FAIL' /tmp/frontdesk-supa-verify.txt
echo "== API roles cannot read Frontdesk tables (Data API bypass check)"
for r in anon authenticated service_role; do
  if sq -c "SET ROLE $r; SELECT count(*) FROM public.\"Ticket\";" >/dev/null 2>&1; then echo "FAIL: $r can read Ticket"; exit 1; else echo "OK: $r denied"; fi
done
echo "== explicit seed (owner role)"
MIGRATION_DATABASE_URL="$OWNER_URL" SEED_CREDENTIALS=write SEED_TARGET_LABEL=$LABEL npx tsx prisma/seed.ts | tail -1 | cut -c1-120
echo "== real API as frontdesk_app (startup privilege verification + readiness + production smoke)"
JWT=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")
CSRF=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")
NODE_ENV=production PORT=$APP_PORT PUBLIC_ORIGIN="http://localhost:$APP_PORT" ALLOW_LOOPBACK_HTTP_IN_PRODUCTION=true \
  JWT_SECRET="$JWT" CSRF_SIGNING_KEY="$CSRF" DATABASE_URL="$APP_URL" WEB_DIST_DIR="$PWD/apps/web/dist" \
  SWEEP_SCHEDULER_ENABLED=true LOG_LEVEL=warn node apps/api/dist/main.js > /tmp/frontdesk-supa-app.log 2>&1 &
APP_PID=$!
for i in $(seq 1 60); do curl -sf "http://localhost:$APP_PORT/api/readyz" >/dev/null && break; sleep 0.5; done
echo "readyz: $(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$APP_PORT/api/readyz")"
node scripts/smoke-prod.mjs --base "http://localhost:$APP_PORT" --creds ".local/credentials.$LABEL.json" | tail -3
echo "rehearsal complete"
