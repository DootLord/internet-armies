// The client <-> shard contract. Everything here is plain data so it can go
// over socket.io unchanged: the LocalShard implements it in-process today, the
// Node server implements it later, and WorldView never knows the difference.
import type { Res, StructureKind } from './defs';
import type { CargoItem, ItemKind } from './ships/cargo';
import type { Fit } from './ships/fitting';
import type { HullId } from './ships/hulls';

export interface BuildCheck {
  ok: boolean;
  reason?: string;
}

export interface Structure {
  id: number;
  kind: StructureKind;
  owner: number;
  col: number;
  row: number;
  /** Server-clock seconds. Construction state is derived from these, never ticked. */
  startedAt: number;
  finishAt: number;
  level: number;
  /**
   * Health, derived like construction: `hp` at server time `hpAt`, falling at
   * `drain` per second while something fires on it. Clients compute the live
   * value every frame; the shard only sends an update when the rate changes.
   */
  hp: number;
  hpAt: number;
  drain: number;
}

export const hpOf = (s: Structure, now: number) => Math.max(0, s.hp - s.drain * Math.max(0, now - s.hpAt));

export const progressOf = (s: Structure, now: number) =>
  s.finishAt <= s.startedAt ? 1 : Math.min(1, Math.max(0, (now - s.startedAt) / (s.finishAt - s.startedAt)));

/** Full dynamic state of one chunk. `rev` is the chunk's revision on the shard. */
export interface ChunkSnapshot {
  cx: number;
  cy: number;
  rev: number;
  /** Owner per tile (local index), or null when nothing in the chunk is owned. */
  owner: Int32Array | null;
  /** Terrain overrides on top of the procedural terrain: [localIndex, kindId]. */
  terrain: [number, number][];
  structures: Structure[];
}

/**
 * Changes to one chunk since revision `rev - 1`. Every field is an idempotent
 * "set", so re-applying a delta is harmless; a skipped revision triggers resync.
 */
export interface ChunkDelta {
  cx: number;
  cy: number;
  rev: number;
  owners?: [number, number][];
  terrain?: [number, number][];
  upserts?: Structure[];
  /** Local indices whose structure was removed. */
  removes?: number[];
  /** The subset of `removes` that were destroyed by fire (clients play the explosion). */
  destroyed?: number[];
}

/**
 * What the shooter tells the shard when it opens fire. Interim: once flagships
 * live on the server, position and fit come from server state and this shrinks
 * to the target id. The shard already recomputes damage and range from the fit
 * with the shared fitting rules, so the client can't just claim a number.
 */
export interface ShipReport {
  x: number;
  y: number;
  hull: HullId;
  fit: Fit;
}

export interface FireOrder extends ShipReport {
  target: number;
}

/** Somewhere items live: one of the player's ship holds, or a Storage building. */
export type Container = { ship: HullId; fit: Fit } | { storage: number };

/**
 * A cargo intent. The shard checks it with cargo.ts (fit, overlap, range to a
 * Storage) and answers with fresh CargoState either way, so a client that
 * applied it optimistically always ends up matching the shard.
 */
export type CargoOp =
  | { op: 'move'; from: Container; uid: number; to: Container; x: number; y: number; rot: boolean }
  | { op: 'jettison'; from: Container; uid: number };

/** Everything the player owns in cargo: each hull's hold and each of their Storage buildings. */
export interface CargoState {
  holds: Record<HullId, CargoItem[]>;
  stores: Record<number, CargoItem[]>;
}

export interface CacheResult extends BuildCheck {
  loot?: ItemKind[];
  /** Items that didn't fit in the hold and were left behind. */
  lost?: number;
}

export interface PlayerState {
  res: Res;
  rates: Res;
  sectors: number;
  structures: number;
  cycle: number;
}

/** Coarse whole-world ownership grid for the minimap and far zoom. */
export interface Overview {
  x0: number;
  y0: number;
  /** Cell size in world pixels (square). */
  cell: number;
  w: number;
  h: number;
  owner: Int32Array;
  version: number;
}

export interface WorldEvent {
  id: number;
  cycle: number;
  faction: number;
  text: string;
  type: 'build' | 'online' | 'claim' | 'info';
  col?: number;
  row?: number;
}

export interface WorldMeta {
  seed: number;
  /** Radius of the playable disc in world pixels. Can grow over time. */
  radiusPx: number;
  homes: { col: number; row: number }[];
  player: number;
}

export interface SourceHandlers {
  chunk(s: ChunkSnapshot): void;
  delta(d: ChunkDelta): void;
  player(p: PlayerState): void;
  overview(o: Overview): void;
  event(e: WorldEvent): void;
  cargo(c: CargoState): void;
}

export interface WorldSource {
  connect(h: SourceHandlers): Promise<WorldMeta>;
  /** Start streaming these chunks (by chunk key): a snapshot, then deltas. */
  subscribe(keys: number[]): void;
  unsubscribe(keys: number[]): void;
  build(kind: StructureKind, col: number, row: number): Promise<BuildCheck>;
  demolish(col: number, row: number): Promise<BuildCheck>;
  /** Start firing at a structure, or stop with null. One target per shooter. */
  fire(order: FireOrder | null): Promise<BuildCheck>;
  cargo(op: CargoOp, ship: ShipReport): Promise<BuildCheck>;
  /** Crack open the cache tile at col,row into the ship's hold. */
  openCache(col: number, row: number, ship: ShipReport): Promise<CacheResult>;
  /** Server clock in seconds. */
  now(): number;
}
