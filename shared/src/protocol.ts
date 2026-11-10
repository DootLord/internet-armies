// The client <-> shard contract. Everything here is plain data so it can go
// over socket.io unchanged: the LocalShard implements it in-process today, the
// Node server implements it later, and WorldView never knows the difference.
import type { Res, StructureKind } from './defs';
import type { CargoItem, ItemKind } from './ships/cargo';
import type { Fit } from './ships/fitting';
import type { FleetState } from './ships/fleet';

export interface BuildCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Health, derived like construction: `hp` at server time `hpAt`, falling at
 * `drain` per second while something fires on it. Clients compute the live
 * value every frame; the shard only sends an update when the rate changes.
 */
export interface Health {
  hp: number;
  hpAt: number;
  drain: number;
}

export interface Structure extends Health {
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

export const hpOf = (s: Health, now: number) => Math.max(0, s.hp - s.drain * Math.max(0, now - s.hpAt));

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
 * Where the flagship is. The shard already knows which ship you fly and its
 * fit (it owns the fleet); position is the one thing it still takes on trust
 * until flight runs server-side too.
 */
export interface ShipReport {
  x: number;
  y: number;
}

export interface FireOrder extends ShipReport {
  /** A structure id, or a squad id when `unit` is set. */
  target: number;
  unit?: boolean;
}

/**
 * A squad of troopers marching on an enemy structure. Like construction and
 * health, where it is follows from server time: it walks `route` (flat x,y
 * world points) at `speed` from `startAt`, then stands and fires on `target`.
 * The shard sends it again only when that plan changes (a retarget) or its
 * health rate does. Troopers fall one by one as the shared pool drains.
 */
export interface Squad extends Health {
  id: number;
  owner: number;
  target: number;
  route: number[];
  startAt: number;
  speed: number;
  /** Troopers it set out with; each holds TROOPER_HP of the pool. */
  size: number;
  /** Structures shooting at it right now, so clients can draw the fire. */
  attackers: number[];
}

/** Somewhere items live: a ship's hold (by ship id), or a Storage Bay / Hangar item bay (by structure id). */
export type Container = { ship: number } | { store: number };

/**
 * A cargo intent. The shard checks it with cargo.ts (fit, overlap, reach) and
 * answers with fresh CargoState either way, so a client that applied it
 * optimistically always ends up matching the shard. Items move between any
 * two containers you can reach at once: your flown ship, ships stationed in
 * the Hangar you're docked at, its item bay, and Storage Bays in range.
 */
export type CargoOp =
  | { op: 'move'; from: Container; uid: number; to: Container; x: number; y: number; rot: boolean }
  | { op: 'jettison'; from: Container; uid: number };

/** Everything the player owns in cargo: each ship's hold and each of their Storage Bays and Hangar bays. */
export interface CargoState {
  holds: Record<number, CargoItem[]>;
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

/**
 * The overview as it travels: only owned cells, as [cell, owner] pairs. Most
 * of the disc is unowned, so this is a few KB instead of the dense grid's
 * hundreds; the receiving side expands it with expandOverview().
 */
export interface OverviewWire {
  x0: number;
  y0: number;
  cell: number;
  w: number;
  h: number;
  cells: Int32Array;
  version: number;
}

export function expandOverview(o: OverviewWire): Overview {
  const owner = new Int32Array(o.w * o.h).fill(-1);
  for (let i = 0; i < o.cells.length; i += 2) owner[o.cells[i]] = o.cells[i + 1];
  return { x0: o.x0, y0: o.y0, cell: o.cell, w: o.w, h: o.h, owner, version: o.version };
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

/** A player's empire as everyone else sees it: owner ids on tiles and structures are empire ids. */
export interface EmpireInfo {
  id: number;
  name: string;
  /** Index into the faction colour palette (FACTIONS). */
  color: number;
}

export interface WorldMeta {
  seed: number;
  /** Radius of the playable disc in world pixels. Can grow over time. */
  radiusPx: number;
  /** Home Nexus tiles by empire id. Always holds your own. */
  homes: Record<number, { col: number; row: number }>;
  /** Your empire id. */
  player: number;
  /** Where your flagship was when you last left (the shard's validated position). */
  ship: ShipReport;
  /** Server clock (seconds) when this was sent, for the client's clock sync. */
  now: number;
}

/**
 * Everything the shard pushes, as one tagged union. The server sends these
 * over the message bus and the socket unchanged; both WorldSources turn them
 * into SourceHandlers calls with dispatch().
 */
export type Push =
  | { t: 'chunks'; list: ChunkSnapshot[] }
  | { t: 'delta'; d: ChunkDelta }
  | { t: 'player'; p: PlayerState }
  | { t: 'overview'; o: OverviewWire }
  | { t: 'event'; e: WorldEvent }
  | { t: 'cargo'; c: CargoState }
  | { t: 'fleet'; f: FleetState }
  | { t: 'squads'; changed: Squad[]; gone: number[] }
  | { t: 'empires'; list: EmpireInfo[] }
  /** Your reported position was impossible: the shard puts the ship back here. */
  | { t: 'correct'; x: number; y: number };

export function dispatch(h: SourceHandlers, m: Push) {
  switch (m.t) {
    case 'chunks': for (const s of m.list) h.chunk(s); break;
    case 'delta': h.delta(m.d); break;
    case 'player': h.player(m.p); break;
    case 'overview': h.overview(expandOverview(m.o)); break;
    case 'event': h.event(m.e); break;
    case 'cargo': h.cargo(m.c); break;
    case 'fleet': h.fleet(m.f); break;
    case 'squads': h.squads(m.changed, m.gone); break;
    case 'empires': h.empires(m.list); break;
    case 'correct': h.correct({ x: m.x, y: m.y }); break;
  }
}

export interface SourceHandlers {
  chunk(s: ChunkSnapshot): void;
  delta(d: ChunkDelta): void;
  player(p: PlayerState): void;
  overview(o: Overview): void;
  event(e: WorldEvent): void;
  cargo(c: CargoState): void;
  fleet(f: FleetState): void;
  /** Squads that appeared or changed, and ids that are gone (killed or stood down). */
  squads(changed: Squad[], gone: number[]): void;
  /** Names and colours for empire ids (new players, renames). */
  empires(list: EmpireInfo[]): void;
  /** The shard rejected a reported position and put the flagship back here. */
  correct(at: ShipReport): void;
}

export interface WorldSource {
  connect(h: SourceHandlers): Promise<WorldMeta>;
  /** Start streaming these chunks (by chunk key): a snapshot, then deltas. */
  subscribe(keys: number[]): void;
  unsubscribe(keys: number[]): void;
  build(kind: StructureKind, col: number, row: number): Promise<BuildCheck>;
  demolish(col: number, row: number): Promise<BuildCheck>;
  /** Start firing at a structure or squad, or stop with null. One target per shooter. */
  fire(order: FireOrder | null): Promise<BuildCheck>;
  cargo(op: CargoOp, ship: ShipReport): Promise<BuildCheck>;
  /** Crack open the cache tile at col,row into the ship's hold. */
  openCache(col: number, row: number, ship: ShipReport): Promise<CacheResult>;
  /** Swap into a ship stationed at the Hangar you're docked at; the one you flew stays there. */
  board(shipId: number, ship: ShipReport): Promise<BuildCheck>;
  /** Replace a ship's whole fit. Needs it docked: flown and in range of a Hangar, or stationed at the one you're docked at. */
  refit(shipId: number, fit: Fit, ship: ShipReport): Promise<BuildCheck>;
  /** Send a squad from one of your Mech Bays to assault an enemy structure. */
  deploy(bay: number, target: number): Promise<BuildCheck>;
  /** Where the flagship is, a few times a second. The shard checks it against the hull's top speed. */
  report(ship: ShipReport): void;
  /** Server clock in seconds. */
  now(): number;
}
