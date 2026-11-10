// The accounts schema. Append-only: add a new migration, never edit a shipped one.
//
// Data minimisation (GDPR): we keep no email, no password and no profile, only
// an opaque id per linked provider. Deleting an account cascades to everything
// keyed by it here, and an outbox row tells the shards to erase the empire too.
import type { Migration } from '@eden/kit/db';

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'accounts, sessions, identities',
    sql: `
      CREATE TABLE accounts (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        created_at    timestamptz NOT NULL DEFAULT now(),
        last_seen_at  timestamptz NOT NULL DEFAULT now()
      );

      -- One empire per account for now. Its id is what tiles and structures are owned by.
      CREATE TABLE empires (
        id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        account_id  uuid NOT NULL UNIQUE REFERENCES accounts ON DELETE CASCADE,
        name        text NOT NULL,
        color       smallint NOT NULL
      );

      -- A device stays signed in with a long random secret; we store only its hash,
      -- so a database leak doesn't hand out live sessions.
      CREATE TABLE sessions (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        account_id    uuid NOT NULL REFERENCES accounts ON DELETE CASCADE,
        secret_hash   bytea NOT NULL UNIQUE,
        created_at    timestamptz NOT NULL DEFAULT now(),
        last_used_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX sessions_account ON sessions (account_id);

      -- Linked sign-in providers. (provider, subject) is the provider's stable user id.
      CREATE TABLE identities (
        provider    text NOT NULL,
        subject     text NOT NULL,
        account_id  uuid NOT NULL REFERENCES accounts ON DELETE CASCADE,
        created_at  timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (provider, subject)
      );
      CREATE INDEX identities_account ON identities (account_id);

      -- Keys for signing access tokens. Shared by every replica through the database;
      -- the public halves are served as a JWKS for the gateway to verify against.
      CREATE TABLE signing_keys (
        kid          text PRIMARY KEY,
        private_jwk  jsonb NOT NULL,
        public_jwk   jsonb NOT NULL,
        created_at   timestamptz NOT NULL DEFAULT now()
      );

      -- Transactional outbox: events written in the same transaction as the change
      -- they announce, then delivered by a relay loop until someone acknowledges them.
      CREATE TABLE outbox (
        id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        subject     text NOT NULL,
        payload     jsonb NOT NULL,
        attempts    int NOT NULL DEFAULT 0,
        created_at  timestamptz NOT NULL DEFAULT now()
      );
    `,
  },
];
