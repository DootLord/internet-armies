// Postgres persistence for one sector: load it whole at boot, then save batches
// of changes. Each batch is one transaction, and each table is written with a
// single statement however many rows changed (rows go in as one JSON array and
// Postgres unpacks it with jsonb_to_recordset): ten changes or ten thousand
// cost the same number of round trips.
import { Pool, tx } from '@eden/kit/db';
import type { Logger } from '@eden/kit/log';
import type { Sector, SectorChanges, SectorData } from '@eden/shared/sim/Sector';
import type { CargoItem } from '@eden/shared/ships/cargo';

export interface SectorRecord {
  epoch: number;
  data: SectorData | undefined;
}

export class Store {
  constructor(private db: Pool, private sector: number) {}

  /** Load the sector, or create it on first boot. */
  async load(seed: number, radiusPx: number): Promise<SectorRecord> {
    const s = this.sector;
    const row = (await this.db.query('SELECT seed, radius_px, epoch, saved_at FROM sectors WHERE id = $1', [s])).rows[0];
    if (!row) {
      const epoch = Date.now() / 1000;
      await this.db.query('INSERT INTO sectors (id, seed, radius_px, epoch) VALUES ($1, $2, $3, $4)', [s, seed, radiusPx, epoch]);
      return { epoch, data: undefined };
    }
    if (Number(row.seed) !== seed || row.radius_px !== radiusPx)
      throw new Error(`Sector ${s} was created with seed ${row.seed}, radius ${row.radius_px}; refusing to load it as ${seed}, ${radiusPx}`);
    const q = async (sql: string) => (await this.db.query(sql, [s])).rows;
    const [empires, structures, chunks, ships, items, squads] = await Promise.all([
      q('SELECT * FROM empires WHERE sector = $1'),
      q('SELECT * FROM structures WHERE sector = $1'),
      q('SELECT * FROM chunks WHERE sector = $1'),
      q('SELECT * FROM ships WHERE sector = $1'),
      q('SELECT * FROM items WHERE sector = $1 ORDER BY uid'),
      q('SELECT data FROM squads WHERE sector = $1'),
    ]);
    const containers = new Map<string, { key: string; owner: number; items: CargoItem[] }>();
    for (const it of items) {
      let c = containers.get(it.container);
      if (!c) containers.set(it.container, (c = { key: it.container, owner: it.owner, items: [] }));
      c.items.push({ uid: it.uid, kind: it.kind, x: it.x, y: it.y, rot: it.rot });
    }
    return {
      epoch: row.epoch,
      data: {
        savedAt: row.saved_at,
        empires: empires.map((e) => ({
          id: e.id, name: e.name, color: e.color, home: { col: e.home_col, row: e.home_row }, res: e.res, resAt: e.res_at, flying: e.flying,
          pos: { x: e.pos_x, y: e.pos_y },
        })),
        structures: structures.map((r) => ({
          id: r.id, kind: r.kind, owner: r.owner, col: r.col, row: r.row, startedAt: r.started_at, finishAt: r.finish_at, level: r.level,
          hp: r.hp, hpAt: r.hp_at, drain: r.drain,
        })),
        chunks: chunks.map((c) => ({ ck: c.ck, rev: c.rev, owners: c.owners, terrain: c.terrain, opened: c.opened })),
        ships: ships.map((r) => ({ id: r.id, owner: r.owner, hull: r.hull, fit: r.fit, station: r.station })),
        containers: [...containers.values()],
        squads: squads.map((r) => r.data),
      },
    };
  }

  /** Write one batch atomically: deletes first (a demolished structure frees its tile), then upserts. */
  async save(c: SectorChanges) {
    const s = this.sector;
    await tx(this.db, async (db) => {
      const del = async (table: string, col: string, ids: (number | string)[]) => {
        if (ids.length) await db.query(`DELETE FROM ${table} WHERE sector = $1 AND ${col} = ANY($2)`, [s, ids]);
      };
      await del('structures', 'id', c.goneStructures);
      await del('ships', 'id', c.goneShips);
      await del('squads', 'id', c.goneSquads);
      await del('empires', 'id', c.goneEmpires);
      // A container is rewritten whole: drop its rows, insert what it holds now.
      await del('items', 'container', [...c.goneContainers, ...c.containers.map((x) => x.key)]);

      const upsert = async (sql: string, rows: unknown[]) => {
        if (rows.length) await db.query(sql, [s, JSON.stringify(rows)]);
      };
      await upsert(
        `INSERT INTO empires (sector, id, name, color, home_col, home_row, res, res_at, flying, pos_x, pos_y)
         SELECT $1, id, name, color, home_col, home_row, res, res_at, flying, pos_x, pos_y
         FROM jsonb_to_recordset($2::jsonb) AS t(id bigint, name text, color smallint, home_col int, home_row int, res jsonb, res_at float8, flying bigint, pos_x float8, pos_y float8)
         ON CONFLICT (sector, id) DO UPDATE SET name = excluded.name, color = excluded.color, res = excluded.res, res_at = excluded.res_at,
           flying = excluded.flying, pos_x = excluded.pos_x, pos_y = excluded.pos_y`,
        c.empires.map((e) => ({ id: e.id, name: e.name, color: e.color, home_col: e.home.col, home_row: e.home.row, res: e.res, res_at: e.resAt, flying: e.flying, pos_x: e.pos.x, pos_y: e.pos.y })),
      );
      await upsert(
        `INSERT INTO structures (sector, id, kind, owner, col, "row", started_at, finish_at, level, hp, hp_at, drain)
         SELECT $1, id, kind, owner, col, "row", started_at, finish_at, level, hp, hp_at, drain
         FROM jsonb_to_recordset($2::jsonb) AS t(id bigint, kind text, owner bigint, col int, "row" int, started_at float8, finish_at float8, level int, hp float8, hp_at float8, drain float8)
         ON CONFLICT (sector, id) DO UPDATE SET level = excluded.level, hp = excluded.hp, hp_at = excluded.hp_at, drain = excluded.drain,
           started_at = excluded.started_at, finish_at = excluded.finish_at`,
        c.structures.map((x) => ({ id: x.id, kind: x.kind, owner: x.owner, col: x.col, row: x.row, started_at: x.startedAt, finish_at: x.finishAt, level: x.level, hp: x.hp, hp_at: x.hpAt, drain: x.drain })),
      );
      await upsert(
        `INSERT INTO chunks (sector, ck, rev, owners, terrain, opened)
         SELECT $1, ck, rev, owners, terrain, opened FROM jsonb_to_recordset($2::jsonb) AS t(ck bigint, rev int, owners jsonb, terrain jsonb, opened jsonb)
         ON CONFLICT (sector, ck) DO UPDATE SET rev = excluded.rev, owners = excluded.owners, terrain = excluded.terrain, opened = excluded.opened`,
        c.chunks,
      );
      await upsert(
        `INSERT INTO ships (sector, id, owner, hull, fit, station)
         SELECT $1, id, owner, hull, fit, station FROM jsonb_to_recordset($2::jsonb) AS t(id bigint, owner bigint, hull text, fit jsonb, station bigint)
         ON CONFLICT (sector, id) DO UPDATE SET owner = excluded.owner, hull = excluded.hull, fit = excluded.fit, station = excluded.station`,
        c.ships,
      );
      await upsert(
        `INSERT INTO items (sector, uid, container, owner, kind, x, y, rot)
         SELECT $1, uid, container, owner, kind, x, y, rot FROM jsonb_to_recordset($2::jsonb) AS t(uid bigint, container text, owner bigint, kind text, x int, y int, rot boolean)`,
        c.containers.flatMap((k) => k.items.map((it) => ({ ...it, container: k.key, owner: k.owner }))),
      );
      await upsert(
        `INSERT INTO squads (sector, id, data) SELECT $1, id, data FROM jsonb_to_recordset($2::jsonb) AS t(id bigint, data jsonb)
         ON CONFLICT (sector, id) DO UPDATE SET data = excluded.data`,
        c.squads.map((q) => ({ id: q.id, data: q })),
      );
      await db.query('UPDATE sectors SET saved_at = $2 WHERE id = $1', [s, c.savedAt]);
    });
  }
}

/**
 * Group commit. Anyone can ask for a flush and gets a promise that resolves once
 * everything changed *before they asked* is in the database. While a save is
 * running, new requests share the single save queued behind it, so a burst of
 * intents costs two transactions, not one per intent.
 *
 * A failed save is fatal: the changes already left the sector's dirty set, so
 * memory and disk now disagree. The only safe move is to stop and let the
 * restart reload the last good state (fail-stop), losing at most what was
 * never acknowledged.
 */
export class Saver {
  private running: Promise<void> | null = null;
  private queued: Promise<void> | null = null;
  private last = { ms: 0, rows: 0 };

  constructor(private sector: Sector, private store: Store, private log: Logger, private onFatal: (e: unknown) => void) {}

  get stats() {
    return this.last;
  }

  flush(): Promise<void> {
    if (!this.running) {
      this.running = this.run().finally(() => (this.running = null));
      return this.running;
    }
    this.queued ??= this.running.then(() => {
      this.queued = null;
      return this.flush();
    });
    return this.queued;
  }

  private async run() {
    if (!this.sector.hasChanges) return;
    const c = this.sector.takeChanges(), t0 = performance.now();
    try {
      await this.store.save(c);
    } catch (e) {
      this.log.fatal({ err: e }, 'save failed; stopping so a restart reloads the last good state');
      this.onFatal(e);
      throw e;
    }
    const rows = c.empires.length + c.structures.length + c.chunks.length + c.ships.length + c.containers.length + c.squads.length;
    this.last = { ms: performance.now() - t0, rows };
    if (this.last.ms > 250) this.log.warn(this.last, 'slow save');
  }
}
