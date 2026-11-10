// Postgres access and schema migrations.
//
// Each service owns one schema (accounts, shard...) and connects as its own
// role that can only touch that schema: "database per service" without paying
// for one Postgres instance each. No service reads another's tables; they talk
// over NATS instead.
import pg from 'pg';
import type { Logger } from './log';

// int8 (bigint) arrives as a string by default because it can exceed 2^53.
// Our ids and keys never do, so take them as plain numbers.
pg.types.setTypeParser(20, Number);

/** A connection pool whose queries resolve unqualified table names in `schema`. */
export function pool(url: string, schema: string) {
  return new pg.Pool({ connectionString: url, max: 10, options: `-c search_path=${schema}` });
}

export type Pool = pg.Pool;
export type Client = pg.PoolClient;

export interface Migration {
  id: number;
  name: string;
  sql: string;
}

/**
 * Apply pending migrations in order, each in its own transaction, recording
 * them in <schema>.migrations. A Postgres advisory lock makes this safe when
 * several replicas boot at once: one migrates, the others wait, then find
 * nothing to do. Migrations are append-only: never edit one that has shipped.
 */
export async function migrate(db: Pool, schema: string, migrations: Migration[], log: Logger) {
  const c = await db.connect();
  try {
    await c.query('SELECT pg_advisory_lock(hashtext($1))', [`migrate:${schema}`]);
    // In production the schema is pre-created for the service's role, which can't create schemas
    // (even IF NOT EXISTS needs that right), so only create it when it's really missing (local dev).
    const has = (await c.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [schema])).rowCount;
    if (!has) await c.query(`CREATE SCHEMA ${schema}`);
    await c.query(`CREATE TABLE IF NOT EXISTS ${schema}.migrations (id int PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await c.query(`SELECT id FROM ${schema}.migrations`)).rows.map((r) => r.id as number));
    for (const m of [...migrations].sort((a, b) => a.id - b.id)) {
      if (done.has(m.id)) continue;
      log.info({ migration: m.id, name: m.name }, 'applying migration');
      await c.query('BEGIN');
      try {
        await c.query(`SET LOCAL search_path TO ${schema}`);
        await c.query(m.sql);
        await c.query(`INSERT INTO ${schema}.migrations (id, name) VALUES ($1, $2)`, [m.id, m.name]);
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    await c.query('SELECT pg_advisory_unlock(hashtext($1))', [`migrate:${schema}`]).catch(() => {});
    c.release();
  }
}

/** Run `fn` in a transaction on one connection: all of it commits, or none of it does. */
export async function tx<T>(db: Pool, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
