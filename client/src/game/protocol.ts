// The client <-> shard contract. Everything here is plain data so it can go
// over socket.io unchanged: the LocalShard implements it in-process today, the
// Node server implements it later, and WorldView never knows the difference.
import type { Res, StructureKind } from './defs';

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
}

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
}

export interface WorldSource {
  connect(h: SourceHandlers): Promise<WorldMeta>;
  /** Start streaming these chunks (by chunk key): a snapshot, then deltas. */
  subscribe(keys: number[]): void;
  unsubscribe(keys: number[]): void;
  build(kind: StructureKind, col: number, row: number): Promise<BuildCheck>;
  demolish(col: number, row: number): Promise<BuildCheck>;
  /** Server clock in seconds. */
  now(): number;
}
