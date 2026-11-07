BEGIN;

CREATE TABLE IF NOT EXISTS accounts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email text NOT NULL UNIQUE CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254),
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS empires (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY CHECK (id > 0),
  account_id bigint NOT NULL UNIQUE REFERENCES accounts(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  tag text NOT NULL CHECK (length(tag) BETWEEN 1 AND 8),
  color text NOT NULL CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sectors (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL UNIQUE,
  terrain_seed integer NOT NULL,
  terrain_version integer NOT NULL CHECK (terrain_version > 0),
  radius_px integer NOT NULL CHECK (radius_px > 0)
);

-- Only changed tiles are stored; missing rows use generated terrain and no owner.
CREATE TABLE IF NOT EXISTS tiles (
  sector_id integer NOT NULL REFERENCES sectors(id),
  col integer NOT NULL CHECK (col BETWEEN -32768 AND 32767),
  row integer NOT NULL CHECK (row BETWEEN -32768 AND 32767),
  owner_id integer REFERENCES empires(id),
  terrain_override smallint CHECK (terrain_override BETWEEN 0 AND 9),
  PRIMARY KEY (sector_id, col, row),
  CHECK (owner_id IS NOT NULL OR terrain_override IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS tiles_owner_idx ON tiles(owner_id) WHERE owner_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS structures (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sector_id integer NOT NULL REFERENCES sectors(id),
  col integer NOT NULL CHECK (col BETWEEN -32768 AND 32767),
  row integer NOT NULL CHECK (row BETWEEN -32768 AND 32767),
  owner_id integer NOT NULL REFERENCES empires(id),
  kind text NOT NULL CHECK (kind IN ('nexus', 'extractor', 'solar', 'habitat', 'turret', 'shield', 'relay', 'dronebay', 'mechbay', 'depot', 'repair', 'storage', 'hangar')),
  level integer NOT NULL DEFAULT 1 CHECK (level > 0),
  started_at timestamptz NOT NULL,
  finish_at timestamptz NOT NULL CHECK (finish_at >= started_at),
  hp double precision NOT NULL CHECK (hp >= 0),
  UNIQUE (sector_id, col, row)
);
CREATE INDEX IF NOT EXISTS structures_owner_idx ON structures(owner_id);

CREATE TABLE IF NOT EXISTS empire_wallets (
  empire_id integer PRIMARY KEY REFERENCES empires(id),
  credits bigint NOT NULL DEFAULT 0 CHECK (credits >= 0)
);
CREATE TABLE IF NOT EXISTS sector_stockpiles (
  empire_id integer NOT NULL REFERENCES empires(id),
  sector_id integer NOT NULL REFERENCES sectors(id),
  alloy bigint NOT NULL DEFAULT 0 CHECK (alloy >= 0),
  energy bigint NOT NULL DEFAULT 0 CHECK (energy >= 0),
  crystal bigint NOT NULL DEFAULT 0 CHECK (crystal >= 0),
  PRIMARY KEY (empire_id, sector_id)
);

CREATE TABLE IF NOT EXISTS starter_templates (
  name text PRIMARY KEY,
  credits bigint NOT NULL CHECK (credits >= 0),
  alloy bigint NOT NULL CHECK (alloy >= 0),
  energy bigint NOT NULL CHECK (energy >= 0),
  crystal bigint NOT NULL CHECK (crystal >= 0)
);

-- Schema required by connect-pg-simple.
CREATE TABLE IF NOT EXISTS user_sessions (
  sid varchar PRIMARY KEY,
  sess json NOT NULL,
  expire timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS user_sessions_expire_idx ON user_sessions(expire);

CREATE TABLE IF NOT EXISTS auth_attempts (
  bucket text PRIMARY KEY,
  count integer NOT NULL CHECK (count > 0),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_attempts_expire_idx ON auth_attempts(expires_at);

COMMIT;
