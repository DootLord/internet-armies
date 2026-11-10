// The shard's schema. Append-only: add a new migration, never edit a shipped one.
//
// Every table is keyed by sector first, so one database can hold many sectors
// today and the tables can be partitioned by sector if one ever gets too big.
// Times are sector seconds (double precision), matching the simulation; the
// sector's epoch turns them back into wall-clock time.
import type { Migration } from '@eden/kit/db';

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'initial world',
    sql: `
      CREATE TABLE sectors (
        id          int PRIMARY KEY,
        seed        bigint NOT NULL,
        radius_px   int NOT NULL,
        -- Unix seconds at sector time 0. Sector time keeps counting across restarts.
        epoch       double precision NOT NULL,
        -- Sector time of the last committed save, so a restart knows how long it was down.
        saved_at    double precision NOT NULL DEFAULT 0,
        created_at  timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE empires (
        sector    int NOT NULL REFERENCES sectors,
        id        bigint NOT NULL,           -- issued by the accounts service
        name      text NOT NULL,
        color     smallint NOT NULL,
        home_col  int NOT NULL,
        home_row  int NOT NULL,
        res       jsonb NOT NULL,             -- resources at res_at, a line like health
        res_at    double precision NOT NULL,
        flying    bigint NOT NULL,
        pos_x     double precision NOT NULL,
        pos_y     double precision NOT NULL,
        PRIMARY KEY (sector, id)
      );

      CREATE TABLE structures (
        sector     int NOT NULL REFERENCES sectors,
        id         bigint NOT NULL,
        kind       text NOT NULL,
        owner      bigint NOT NULL,
        col        int NOT NULL,
        "row"      int NOT NULL,
        started_at double precision NOT NULL,
        finish_at  double precision NOT NULL,
        level      int NOT NULL,
        hp         double precision NOT NULL,
        hp_at      double precision NOT NULL,
        drain      double precision NOT NULL,
        PRIMARY KEY (sector, id)
      );
      -- One structure per tile, enforced by the database as well as the simulation.
      CREATE UNIQUE INDEX structures_tile ON structures (sector, col, "row");
      CREATE INDEX structures_owner ON structures (sector, owner);

      -- Per-chunk tile state the procedural terrain doesn't already give us.
      -- Stored whole per chunk: a chunk is written as one row however many of its tiles changed.
      CREATE TABLE chunks (
        sector   int NOT NULL REFERENCES sectors,
        ck       bigint NOT NULL,
        rev      int NOT NULL,
        owners   jsonb NOT NULL,   -- [[localIndex, empire], ...]
        terrain  jsonb NOT NULL,   -- [[localIndex, kindId], ...] overrides
        opened   jsonb NOT NULL,   -- [[localIndex, restocksAt], ...] looted caches
        PRIMARY KEY (sector, ck)
      );

      CREATE TABLE ships (
        sector   int NOT NULL REFERENCES sectors,
        id       bigint NOT NULL,
        owner    bigint NOT NULL,
        hull     text NOT NULL,
        fit      jsonb NOT NULL,
        station  bigint,            -- Hangar id; NULL while flown, -1 while homeless
        PRIMARY KEY (sector, id)
      );
      CREATE INDEX ships_owner ON ships (sector, owner);

      -- One row per item. The primary key on uid means an item can only ever be
      -- in one container: a bug that duplicated it would make the save fail
      -- (and the shard stop) rather than silently mint loot.
      CREATE TABLE items (
        sector     int NOT NULL REFERENCES sectors,
        uid        bigint NOT NULL,
        container  text NOT NULL,   -- 'h<shipId>' ship hold, 's<structureId>' storage/hangar bay
        owner      bigint NOT NULL,
        kind       text NOT NULL,
        x          int NOT NULL,
        y          int NOT NULL,
        rot        boolean NOT NULL,
        PRIMARY KEY (sector, uid)
      );
      CREATE INDEX items_container ON items (sector, container);

      -- Squads live minutes at most; their whole state is one document.
      CREATE TABLE squads (
        sector  int NOT NULL REFERENCES sectors,
        id      bigint NOT NULL,
        data    jsonb NOT NULL,
        PRIMARY KEY (sector, id)
      );
    `,
  },
];
