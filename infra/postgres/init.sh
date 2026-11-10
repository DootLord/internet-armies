#!/bin/sh
# Runs once, when the Postgres volume is first created. One database, one
# schema per service, one login role per service that owns only its schema:
# the accounts service can't read the world, and the shard can't read sessions.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE ROLE accounts_svc LOGIN PASSWORD '${ACCOUNTS_DB_PASSWORD}';
CREATE ROLE shard_svc LOGIN PASSWORD '${SHARD_DB_PASSWORD}';

CREATE SCHEMA accounts AUTHORIZATION accounts_svc;
CREATE SCHEMA shard AUTHORIZATION shard_svc;

-- Nobody gets to create things in the shared public schema.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON DATABASE ${POSTGRES_DB} FROM PUBLIC;
GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO accounts_svc, shard_svc;
SQL
