#!/bin/sh
# Role provisioning (environment-specific, runs once on a fresh data volume).
# frontdesk_owner : owns the database + schema objects; used by migrations/seed only.
# frontdesk_app   : runtime role; NOSUPERUSER, no CREATE, no ownership, no role memberships.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v owner_pw="$FRONTDESK_OWNER_PASSWORD" -v app_pw="$FRONTDESK_APP_PASSWORD" <<'SQL'
CREATE ROLE frontdesk_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'owner_pw';
CREATE ROLE frontdesk_app   LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD :'app_pw';
-- Owner may create scratch databases for repeatable clean-init verification (never touches other DBs).
ALTER ROLE frontdesk_owner CREATEDB;
CREATE DATABASE frontdesk OWNER frontdesk_owner;
REVOKE ALL ON DATABASE frontdesk FROM PUBLIC;
GRANT CONNECT ON DATABASE frontdesk TO frontdesk_app;
SQL
