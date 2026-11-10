// The authoritative simulation of one sector, for any number of empires. Pure
// game logic: no network, no database, no timers. Adapters drive it:
//
//   LocalShard (in-process, one player, tests/offline)  ─┐
//   services/shard (NATS + Postgres, many players)       ─┼─► Sector
//
// Intents come in as method calls carrying the empire id (the gateway has
// already authenticated it). Everything going out is a Push handed to the
// SectorSink, addressed to one empire, to whoever watches a chunk, or to all.
// Every mutation is also recorded in `dirty`, which persistence drains.
//
// State is sparse (Maps keyed by packed tile coords): cost scales with what
// players have built, not with map size.
import { emptyRes, Res, RES_KEYS, STRUCT, StructureKind, TILE_INFO } from '../defs';
import { hexesInRadius, neighbor } from '../hex';
import { mulberry32 } from '../rng';
import { CHUNK_TILES, CS, CS_BITS, chunkKeyOf, localIndex, pack, unpackA, unpackB } from '../chunks';
import { fillChunk, KIND_ID, KINDS, TerrainParams, tileCenterX, tileCenterY, VOID } from '../terrain';
import { canBuild, WorldRead } from '../rules';
import { hpOf, progressOf } from '../protocol';
import type {
  BuildCheck, CacheResult, CargoOp, CargoState, ChunkDelta, ChunkSnapshot, Container, EmpireInfo, FireOrder, Health, PlayerState, Push, ShipReport,
  Squad, Structure, WorldEvent, WorldMeta,
} from '../protocol';
import {
  addItem, CACHE_RANGE, CACHE_RESPAWN, cargoGrid, CargoItem, Grid, insertItem, ItemKind, moveItem, removeItem, rollLoot, STORAGE_GRID, STORAGE_RANGE,
} from '../ships/cargo';
import { computeStats, Fit, flightParams, weaponStats } from '../ships/fitting';
import { DOCK_RANGE, FleetState, HANGAR_GRID, ShipRecord, validFit } from '../ships/fleet';
import { starterFit } from '../ships/hangar';
import { HULLS } from '../ships/hulls';
import {
  aliveOf, arriveAt, DEPLOY_COOLDOWN, findPath, RETARGET_RANGE, routeFrom, SQUAD_COST, SQUAD_SIZE, squadAt, TROOPER_DPS, TROOPER_HP, TROOPER_SPEED, TURRET_DPS,
  TURRET_RANGE,
} from '../units';

/** Something that can be shot: a structure or a squad, by id. */
type Ref = { s: number } | { q: number };
const sameRef = (a: Ref, b: Ref) => ('s' in a ? 's' in b && a.s === b.s : 'q' in b && a.q === b.q);

/** Where pushes go. The adapter decides what "everyone watching chunk ck" means. */
export interface SectorSink {
  player(empire: number, m: Push): void;
  chunk(ck: number, m: Push): void;
  all(m: Push): void;
}

export interface SectorOptions {
  seed: number;
  radiusPx: number;
  /** Sector time in seconds. Must keep counting across restarts (the server derives it from a stored epoch). */
  clock: () => number;
  sink: SectorSink;
}

const OVERVIEW_CELL = 96;
/** Spawn slots on the sunflower spiral; more players than this start filling gaps at random. */
const SPAWN_SLOTS = 400;
/** A new home needs this many hexes of unowned space around it. */
const SPAWN_CLEARANCE = 8;
/** The flagship appears this far from its Nexus on first spawn and after a wreck. */
const SPAWN_OFFSET = { x: 48, y: 30 };
/** World px around your Nexus and Hangars where a respawning ship may reappear. */
const RESPAWN_RANGE = 200;

/** The hex under a world point, near enough for orders and event locations. */
function tileOf(x: number, y: number): [number, number] {
  const row = Math.round((y - 14) / 21);
  return [Math.round((x - 16 - (row & 1) * 16) / 32), row];
}
const tileObj = (x: number, y: number) => {
  const [col, row] = tileOf(x, y);
  return { col, row };
};

/** One empire on this sector: its economy, fleet and where its flagship is. */
interface Empire {
  id: number;
  info: EmpireInfo;
  home: { col: number; row: number };
  /** Resources as a line, like health: `res` at sector time `resAt`, moving at rates(). Settled whenever rates change or something is spent. */
  res: Res;
  resAt: number;
  rateCache: Res | null;
  ships: Map<number, ShipRecord>;
  flying: number;
  /** Last validated flagship position. */
  pos: ShipReport;
  posAt: number;
  /** Open connections (tabs, devices) playing this empire right now. */
  sessions: number;
  tiles: Set<number>;
  structs: Set<Structure>;
}

/** Rows persistence writes. Plain data, so any store (Postgres, a file, a test double) can take it. */
export interface EmpireRow {
  id: number;
  name: string;
  color: number;
  home: { col: number; row: number };
  res: Res;
  resAt: number;
  flying: number;
  pos: ShipReport;
}
export interface ChunkRow {
  ck: number;
  rev: number;
  owners: [number, number][];
  terrain: [number, number][];
  /** Opened caches: [localIndex, sector time it restocks]. */
  opened: [number, number][];
}
export interface ShipRow extends ShipRecord {
  owner: number;
}
export interface ContainerRow {
  /** 'h<shipId>' for a ship's hold, 's<structureId>' for a Storage or Hangar bay. */
  key: string;
  owner: number;
  items: CargoItem[];
}

/** Everything changed since the last drain. Deleted ids come separately so the store can DELETE them. */
export interface SectorChanges {
  savedAt: number;
  empires: EmpireRow[];
  goneEmpires: number[];
  structures: Structure[];
  goneStructures: number[];
  chunks: ChunkRow[];
  ships: ShipRow[];
  goneShips: number[];
  containers: ContainerRow[];
  goneContainers: string[];
  squads: Squad[];
  goneSquads: number[];
}

/** A whole sector as persistence loaded it. */
export interface SectorData {
  /** Sector time of the last successful save. */
  savedAt: number;
  empires: EmpireRow[];
  structures: Structure[];
  chunks: ChunkRow[];
  ships: ShipRow[];
  containers: ContainerRow[];
  squads: Squad[];
}

const START_RES: Res = { credits: 900, alloy: 450, energy: 60, crystal: 40 };

export class Sector implements WorldRead {
  readonly params: TerrainParams;
  private terrain = new Map<number, Uint8Array>();
  private overrides = new Map<number, number>();
  private owners = new Map<number, number>();
  private structs = new Map<number, Structure>();
  private byId = new Map<number, Structure>();
  private turrets = new Set<Structure>();
  /**
   * Who is shooting whom, keyed by shooter: 'e<empire>' for a flagship, 's<id>'
   * for a Pulse Battery, 'q<id>' for a squad. A target's drain is the sum of its
   * entries, so health stays a straight line between changes.
   */
  private attacks = new Map<string, { target: Ref; dps: number }>();
  private squads = new Map<number, Squad>();
  private squadsDirty = new Set<number>();
  private squadsGone: number[] = [];
  /** Sector time each Mech Bay can deploy again. */
  private bayReady = new Map<number, number>();
  private engageAcc = 0;
  private empires = new Map<number, Empire>();
  /** Which empire owns each ship. */
  private shipOwner = new Map<number, number>();
  private holds = new Map<number, CargoItem[]>();
  private stores = new Map<number, CargoItem[]>();
  private nextItem = 1;
  /** Opened caches: packed tile -> sector time it restocks. */
  private opened = new Map<number, number>();
  private building = new Set<Structure>();
  private revs = new Map<number, number>();
  private pending = new Map<number, ChunkDelta>();
  private log: WorldEvent[] = [];
  private nextId = 1;
  private rnd: () => number;
  private tickAcc = 0;
  private ovAcc = 0;
  private ovDirty = true;
  private ovVersion = 0;
  private clock: () => number;
  private sink: SectorSink;

  /** What changed since persistence last looked. */
  private dirty = {
    empires: new Set<number>(), goneEmpires: new Set<number>(),
    structs: new Set<number>(), goneStructs: new Set<number>(),
    chunks: new Set<number>(),
    ships: new Set<number>(), goneShips: new Set<number>(),
    containers: new Set<string>(), goneContainers: new Set<string>(),
    squads: new Set<number>(), goneSquads: new Set<number>(),
  };

  constructor(o: SectorOptions, data?: SectorData) {
    this.params = { seed: o.seed, radiusPx: o.radiusPx };
    this.clock = o.clock;
    this.sink = o.sink;
    this.rnd = mulberry32(o.seed ^ 0x9e3779b9 ^ Math.floor(this.clock()));
    if (data) this.restore(data);
  }

  now() {
    return this.clock();
  }

  private get cycle() {
    return 4127 + Math.floor(this.now() / 6);
  }

  get empireCount() {
    return this.empires.size;
  }

  online(id: number) {
    return (this.empires.get(id)?.sessions ?? 0) > 0;
  }

  // ---------------------------------------------------------------- sessions
  /**
   * A player connects. First time on this sector, their empire is founded: a
   * Nexus in free space, a starter Hangar and fleet, and caches nearby. The
   * initial state goes out through the sink to that empire.
   */
  join(info: EmpireInfo): WorldMeta {
    let e = this.empires.get(info.id);
    if (!e) e = this.found(info);
    else if (e.info.name !== info.name || e.info.color !== info.color) {
      e.info = { ...info };
      this.dirty.empires.add(e.id);
      this.sink.all({ t: 'empires', list: [{ ...e.info }] });
    }
    e.sessions++;
    this.flushAll();
    const to = (m: Push) => this.sink.player(info.id, m);
    to({ t: 'empires', list: [...this.empires.values()].map((x) => ({ ...x.info })) });
    to({ t: 'player', p: this.playerState(e) });
    to({ t: 'overview', o: this.overviewWire() });
    to({ t: 'fleet', f: this.fleetState(e) });
    to({ t: 'cargo', c: this.cargoState(e) });
    to({ t: 'squads', changed: [...this.squads.values()].map((q) => ({ ...q })), gone: [] });
    for (const ev of [...this.log].reverse()) if (ev.faction === e.id || ev.faction < 0) to({ t: 'event', e: ev });
    const homes: Record<number, { col: number; row: number }> = {};
    for (const x of this.empires.values()) homes[x.info.id] = x.home;
    return { seed: this.params.seed, radiusPx: this.params.radiusPx, homes, player: e.info.id, ship: { ...e.pos }, now: this.now() };
  }

  /** A connection closed. The empire stays in the world; its flagship stops firing. */
  leave(id: number) {
    const e = this.empires.get(id);
    if (!e) return;
    e.sessions = Math.max(0, e.sessions - 1);
    if (!e.sessions) this.ceaseFire(e);
  }

  /** Forget every session (a gateway restarted and will re-join its players). */
  resetSessions() {
    for (const e of this.empires.values()) if (e.sessions) {
      e.sessions = 0;
      this.ceaseFire(e);
    }
  }

  private found(info: EmpireInfo): Empire {
    const home = this.findHome();
    const now = this.now();
    const e: Empire = {
      id: info.id, info: { ...info }, home, res: { ...START_RES }, resAt: now, rateCache: null, ships: new Map(), flying: 0,
      pos: { x: tileCenterX(home.col, home.row) + SPAWN_OFFSET.x, y: tileCenterY(home.row) + SPAWN_OFFSET.y }, posAt: now,
      sessions: 0, tiles: new Set(), structs: new Set(),
    };
    this.empires.set(info.id, e);
    this.dirty.empires.add(info.id);
    this.sink.all({ t: 'empires', list: [{ ...e.info }] });

    for (const [c, r] of hexesInRadius(home.col, home.row, 2)) if (this.kindId(c, r) === VOID) this.setTerrain(c, r, KIND_ID.plate);
    this.place('nexus', home.col, home.row, e.id, true);
    const mine = [...e.tiles].map((k) => [unpackA(k), unpackB(k)] as [number, number]).filter(([c, r]) => !this.structure(c, r));
    if (!mine.some(([c, r]) => TILE_INFO[this.kind(c, r)].deposit)) this.setTerrain(...mine[mine.length - 1], KIND_ID.ore);
    const solar = this.randomOwned(e, false);
    if (solar) this.place('solar', solar[0], solar[1], e.id, true);
    const hangarAt = this.randomOwned(e, false);
    if (hangarAt) this.place('hangar', hangarAt[0], hangarAt[1], e.id, true);
    const dock = hangarAt ? this.structure(...hangarAt)!.id : -1;
    for (const h of HULLS) {
      const id = this.nextItem++;
      e.ships.set(id, { id, hull: h.id, fit: starterFit(h.id), station: h.id === 'lancer' ? null : dock });
      this.shipOwner.set(id, e.id);
      this.dirty.ships.add(id);
      if (h.id === 'lancer') e.flying = id;
    }
    const ring = hexesInRadius(home.col, home.row, 7).filter(([c, r]) => this.kindId(c, r) !== VOID && !this.structure(c, r) && this.owner(c, r) === -1);
    for (let i = 0; i < 3 && ring.length; i++) this.setTerrain(...ring.splice(Math.floor(this.rnd() * ring.length), 1)[0], KIND_ID.cache);
    this.emit({ faction: e.id, type: 'info', col: home.col, row: home.row, text: 'established a Command Nexus' });
    return e;
  }

  /** A home in free space: walk a sunflower spiral (even spread over the disc), skipping anything crowded. */
  private findHome() {
    const R = this.params.radiusPx;
    const free = (h: { col: number; row: number }) => {
      for (const [c, r] of hexesInRadius(h.col, h.row, SPAWN_CLEARANCE)) if (this.owners.has(pack(c, r)) || this.structs.has(pack(c, r))) return false;
      return true;
    };
    for (let i = this.empires.size; i < this.empires.size + SPAWN_SLOTS; i++) {
      const slot = i % SPAWN_SLOTS, r = Math.sqrt((slot + 0.5) / SPAWN_SLOTS) * 0.85 * R, a = slot * 2.39996;
      const h = this.nearestLand(Math.cos(a) * r, Math.sin(a) * r);
      if (free(h)) return h;
    }
    for (let tries = 0; tries < 200; tries++) {
      const r = Math.sqrt(this.rnd()) * 0.85 * R, a = this.rnd() * Math.PI * 2;
      const h = this.nearestLand(Math.cos(a) * r, Math.sin(a) * r);
      if (free(h)) return h;
    }
    return this.nearestLand(0, 0); // the sector is full; a real deployment opens another one long before this
  }

  /**
   * Remove an empire and everything it owns (account deleted). Its territory
   * returns to the wild; structures vanish without wreckage.
   */
  purge(id: number) {
    const e = this.empires.get(id);
    if (!e) return;
    this.ceaseFire(e);
    for (const q of [...this.squads.values()]) if (q.owner === id) this.killSquad(q, false);
    for (const s of [...e.structs]) {
      this.dropAttacksOn({ s: s.id });
      this.attack(`s${s.id}`, null);
      this.removeStruct(s);
      this.dropStore(s.id);
    }
    for (const k of [...e.tiles]) this.setOwner(unpackA(k), unpackB(k), -1);
    for (const sh of e.ships.values()) {
      this.shipOwner.delete(sh.id);
      this.dirty.goneShips.add(sh.id);
      if (this.holds.delete(sh.id)) this.dirty.goneContainers.add(`h${sh.id}`);
    }
    this.empires.delete(id);
    this.dirty.goneEmpires.add(id);
    this.flushAll();
  }

  // ---------------------------------------------------------------- intents
  build(id: number, kind: StructureKind, col: number, row: number): BuildCheck {
    const e = this.empires.get(id);
    if (!e) return { ok: false, reason: 'Not in this sector' };
    const r = canBuild(this, kind, col, row, id, this.resOf(e));
    if (r.ok) {
      this.spend(e, STRUCT[kind].cost);
      this.place(kind, col, row, id, false);
      this.emit({ faction: id, type: 'build', col, row, text: `began construction of ${STRUCT[kind].name}` });
      this.sendPlayer(e);
      this.flushAll();
    }
    return r;
  }

  demolish(id: number, col: number, row: number): BuildCheck {
    const e = this.empires.get(id);
    const s = this.structure(col, row);
    if (!e || !s || s.owner !== id) return { ok: false, reason: 'Nothing to demolish' };
    if (s.kind === 'nexus') return { ok: false, reason: 'The Nexus cannot be demolished' };
    if (this.stores.get(s.id)?.length) return { ok: false, reason: `Empty the ${STRUCT[s.kind].name} first` };
    if (s.kind === 'hangar' && [...e.ships.values()].some((sh) => sh.station === s.id)) return { ok: false, reason: 'Move its ships out first' };
    const cost = STRUCT[s.kind].cost;
    this.removeStruct(s);
    this.dropStore(s.id);
    this.settleRes(e);
    for (const k of RES_KEYS) e.res[k] += Math.floor((cost[k] ?? 0) * 0.5);
    this.emit({ faction: id, type: 'info', col, row, text: `decommissioned ${STRUCT[s.kind].name}` });
    this.sendPlayer(e);
    this.flushAll();
    return { ok: true };
  }

  fire(id: number, order: FireOrder | null): BuildCheck {
    const e = this.empires.get(id);
    if (!e) return { ok: false, reason: 'Not in this sector' };
    this.ceaseFire(e);
    if (!order) return { ok: true };
    const pos = this.track(e, order);
    const now = this.now();
    let at: { x: number; y: number } | null = null, target: Ref;
    if (order.unit) {
      const q = this.squads.get(order.target);
      if (q) at = squadAt(q, now);
      target = { q: order.target };
    } else {
      const s = this.byId.get(order.target);
      if (s) at = { x: tileCenterX(s.col, s.row), y: tileCenterY(s.row) };
      target = { s: order.target };
    }
    if (!at) return { ok: false, reason: 'Target lost' };
    // Damage comes from the fit the shard holds for the ship you're flying, never from the client.
    const me = this.flyingShip(e);
    const w = weaponStats(me.hull, me.fit, 'pulse-laser');
    if (!w.count) return { ok: false, reason: 'No Pulse Laser fitted' };
    if (Math.hypot(at.x - pos.x, at.y - pos.y) > w.range) return { ok: false, reason: 'Out of range' };
    this.attack(`e${id}`, target, w.dps);
    this.flushAll();
    return { ok: true };
  }

  deploy(id: number, bayId: number, targetId: number): BuildCheck {
    const e = this.empires.get(id);
    const b = this.byId.get(bayId), t = this.byId.get(targetId), now = this.now();
    const cost = SQUAD_COST as Partial<Res>;
    if (!e) return { ok: false, reason: 'Not in this sector' };
    if (!b || b.owner !== id || b.kind !== 'mechbay') return { ok: false, reason: 'No Mech Bay' };
    if (progressOf(b, now) < 1) return { ok: false, reason: 'The Mech Bay is still being built' };
    if (!t) return { ok: false, reason: 'Target lost' };
    if (t.owner === id) return { ok: false, reason: 'Pick an enemy structure' };
    if ((this.bayReady.get(b.id) ?? 0) > now) return { ok: false, reason: `Training: ready in ${Math.ceil(this.bayReady.get(b.id)! - now)}s` };
    const res = this.resOf(e);
    if (RES_KEYS.some((k) => res[k] < (cost[k] ?? 0))) return { ok: false, reason: 'Not enough resources' };
    const path = findPath(this, [b.col, b.row], [t.col, t.row]);
    if (!path) return { ok: false, reason: 'No route on foot to that target' };
    this.spend(e, cost);
    this.bayReady.set(b.id, now + DEPLOY_COOLDOWN);
    const q: Squad = {
      id: this.nextId++, owner: id, target: t.id, route: routeFrom(tileCenterX(b.col, b.row), tileCenterY(b.row), path), startAt: now,
      speed: TROOPER_SPEED, size: SQUAD_SIZE, attackers: [], hp: SQUAD_SIZE * TROOPER_HP, hpAt: now, drain: 0,
    };
    this.squads.set(q.id, q);
    this.markSquad(q.id);
    this.emit({ faction: id, type: 'info', col: b.col, row: b.row, text: `deployed a mech against a ${STRUCT[t.kind].name}` });
    this.sendPlayer(e);
    this.flushAll();
    return { ok: true };
  }

  // ---------------------------------------------------------------- flight
  /**
   * Validate a reported flagship position and return the one the shard trusts.
   * A report is accepted if the ship could have flown there at full boost since
   * the last one (with slack for latency), or if it's a respawn next to one of
   * your own Nexus or Hangars. Anything else is answered with a correction.
   */
  private track(e: Empire, at: ShipReport): ShipReport {
    const now = this.now();
    const x = Number(at.x), y = Number(at.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return e.pos;
    const me = this.flyingShip(e);
    const top = flightParams(computeStats(me.hull, me.fit)).boostSpeed;
    const dt = Math.max(0.05, now - e.posAt);
    const reach = top * dt * 1.5 + 60;
    const inDisc = Math.hypot(x, y) <= this.params.radiusPx + 400;
    const ok = inDisc && (Math.hypot(x - e.pos.x, y - e.pos.y) <= reach || this.isRespawnPoint(e, x, y));
    if (!ok) {
      this.sink.player(e.info.id, { t: 'correct', x: e.pos.x, y: e.pos.y });
      e.posAt = now; // the next report is measured from the correction
      return e.pos;
    }
    e.pos = { x, y };
    e.posAt = now;
    this.dirty.empires.add(e.info.id);
    return e.pos;
  }

  private isRespawnPoint(e: Empire, x: number, y: number) {
    for (const s of e.structs)
      if ((s.kind === 'nexus' || s.kind === 'hangar') && Math.hypot(tileCenterX(s.col, s.row) - x, tileCenterY(s.row) - y) <= RESPAWN_RANGE) return true;
    return false;
  }

  report(id: number, at: ShipReport) {
    const e = this.empires.get(id);
    if (e) this.track(e, at);
  }

  // ---------------------------------------------------------------- fleet
  private flyingShip(e: Empire) {
    return e.ships.get(e.flying)!;
  }

  /** The completed Hangar of this empire the ship is docked at, if any. */
  private dockedAt(e: Empire, ship: ShipReport): Structure | null {
    let best: Structure | null = null, bd = DOCK_RANGE;
    for (const s of e.structs) {
      if (s.kind !== 'hangar' || progressOf(s, this.now()) < 1) continue;
      const d = Math.hypot(tileCenterX(s.col, s.row) - ship.x, tileCenterY(s.row) - ship.y);
      if (d <= bd) {
        bd = d;
        best = s;
      }
    }
    return best;
  }

  board(id: number, shipId: number, report: ShipReport): BuildCheck {
    const e = this.empires.get(id);
    if (!e) return { ok: false, reason: 'Not in this sector' };
    const r = ((): BuildCheck => {
      const next = e.ships.get(shipId), h = this.dockedAt(e, this.track(e, report));
      if (!next) return { ok: false, reason: 'No such ship' };
      if (shipId === e.flying) return { ok: false, reason: 'Already aboard' };
      if (!h) return { ok: false, reason: 'Dock at a Hangar first' };
      if (next.station !== h.id) return { ok: false, reason: 'That ship is stationed at another Hangar' };
      const cur = this.flyingShip(e);
      cur.station = h.id;
      next.station = null;
      e.flying = next.id;
      this.dirty.ships.add(cur.id).add(next.id);
      this.dirty.empires.add(id);
      this.ceaseFire(e);
      return { ok: true };
    })();
    this.sendFleet(e);
    return r;
  }

  refit(id: number, shipId: number, fit: Fit, report: ShipReport): BuildCheck {
    const e = this.empires.get(id);
    if (!e) return { ok: false, reason: 'Not in this sector' };
    const r = ((): BuildCheck => {
      const rec = e.ships.get(shipId), h = this.dockedAt(e, this.track(e, report));
      if (!rec) return { ok: false, reason: 'No such ship' };
      if (!h) return { ok: false, reason: 'Dock at a Hangar to refit' };
      if (rec.id !== e.flying && rec.station !== h.id) return { ok: false, reason: 'That ship is stationed at another Hangar' };
      const v = validFit(rec.hull, fit);
      if (!v.ok) return v;
      rec.fit = structuredClone(fit);
      this.dirty.ships.add(rec.id);
      return { ok: true };
    })();
    this.sendFleet(e);
    this.sendCargo(e); // a refit can resize the hold
    return r;
  }

  private fleetState(e: Empire): FleetState {
    return { ships: structuredClone([...e.ships.values()]), flying: e.flying };
  }

  private sendFleet(e: Empire) {
    this.sink.player(e.info.id, { t: 'fleet', f: this.fleetState(e) });
  }

  // ---------------------------------------------------------------- cargo
  cargo(id: number, op: CargoOp, report: ShipReport): BuildCheck {
    const e = this.empires.get(id);
    if (!e) return { ok: false, reason: 'Not in this sector' };
    const r = this.applyCargo(e, op, this.track(e, report));
    // Always answer with the truth, so an optimistic client snaps back if refused.
    this.sendCargo(e);
    return r;
  }

  /** Resolve a container to its items and grid, checking the player can reach it right now. */
  private container(e: Empire, c: Container, ship: ShipReport): { items: CargoItem[]; grid: Grid; set: (v: CargoItem[]) => void } | string {
    if ('ship' in c) {
      const rec = e.ships.get(c.ship);
      if (!rec) return 'No such ship';
      // Your own ship is always in reach; a stationed one only while you're docked at its Hangar.
      if (rec.id !== e.flying && this.dockedAt(e, ship)?.id !== rec.station) return 'Dock at its Hangar first';
      return { items: this.holdOf(rec.id), grid: cargoGrid(computeStats(rec.hull, rec.fit).cargo), set: (v) => this.setHold(rec.id, v) };
    }
    const s = this.byId.get(c.store);
    if (!s || (s.kind !== 'storage' && s.kind !== 'hangar')) return 'Nothing to store items in';
    if (s.owner !== e.info.id) return `Not your ${STRUCT[s.kind].name}`;
    if (progressOf(s, this.now()) < 1) return 'Still under construction';
    const range = s.kind === 'hangar' ? DOCK_RANGE : STORAGE_RANGE;
    if (Math.hypot(tileCenterX(s.col, s.row) - ship.x, tileCenterY(s.row) - ship.y) > range) return `Fly closer to the ${STRUCT[s.kind].name}`;
    return { items: this.storeOf(s.id), grid: s.kind === 'hangar' ? HANGAR_GRID : STORAGE_GRID, set: (v) => this.setStore(s.id, v) };
  }

  private holdOf(id: number) {
    return this.holds.get(id) ?? [];
  }
  private storeOf(id: number) {
    return this.stores.get(id) ?? [];
  }
  private setHold(id: number, v: CargoItem[]) {
    this.holds.set(id, v);
    this.dirty.containers.add(`h${id}`);
  }
  private setStore(id: number, v: CargoItem[]) {
    this.stores.set(id, v);
    this.dirty.containers.add(`s${id}`);
  }
  private dropStore(id: number) {
    if (!this.stores.delete(id)) return false;
    this.dirty.goneContainers.add(`s${id}`);
    return true;
  }

  private applyCargo(e: Empire, op: CargoOp, ship: ShipReport): BuildCheck {
    const from = this.container(e, op.from, ship);
    if (typeof from === 'string') return { ok: false, reason: from };
    const it = from.items.find((o) => o.uid === op.uid);
    if (!it) return { ok: false, reason: 'Item not found' };
    if (op.op === 'jettison') {
      from.set(removeItem(from.items, op.uid));
      return { ok: true };
    }
    if (JSON.stringify(op.from) === JSON.stringify(op.to)) {
      const next = moveItem(from.items, from.grid, op.uid, op.x, op.y, op.rot);
      if (!next) return { ok: false, reason: "Doesn't fit there" };
      from.set(next);
      return { ok: true };
    }
    // Between containers: both must be within reach right now.
    const to = this.container(e, op.to, ship);
    if (typeof to === 'string') return { ok: false, reason: to };
    const next = insertItem(to.items, to.grid, { ...it, x: op.x, y: op.y, rot: op.rot });
    if (!next) return { ok: false, reason: "Doesn't fit there" };
    from.set(removeItem(from.items, op.uid));
    to.set(next);
    return { ok: true };
  }

  openCache(id: number, col: number, row: number, report: ShipReport): CacheResult {
    const e = this.empires.get(id);
    if (!e) return { ok: false, reason: 'Not in this sector' };
    const ship = this.track(e, report);
    if (this.kind(col, row) !== 'cache') return { ok: false, reason: 'Nothing left to open' };
    if (Math.hypot(tileCenterX(col, row) - ship.x, tileCenterY(row) - ship.y) > CACHE_RANGE) return { ok: false, reason: 'Fly closer to the cache' };
    const me = this.flyingShip(e), g = cargoGrid(computeStats(me.hull, me.fit).cargo);
    // Loot is rolled here, never on the client, and lands straight in the hold.
    const loot: ItemKind[] = [];
    let lost = 0;
    for (const kind of rollLoot(this.rnd)) {
      const next = addItem(this.holdOf(me.id), g, kind, this.nextItem);
      if (next) {
        this.setHold(me.id, next);
        this.nextItem++;
        loot.push(kind);
      } else lost++;
    }
    this.setTerrain(col, row, KIND_ID.cacheOpen);
    this.opened.set(pack(col, row), this.now() + CACHE_RESPAWN);
    this.flushAll();
    this.sendCargo(e);
    return { ok: true, loot, lost };
  }

  private cargoState(e: Empire): CargoState {
    const c: CargoState = { holds: {}, stores: {} };
    for (const id of e.ships.keys()) c.holds[id] = structuredClone(this.holdOf(id));
    for (const s of e.structs) if (s.kind === 'storage' || s.kind === 'hangar') c.stores[s.id] = structuredClone(this.storeOf(s.id));
    return c;
  }

  private sendCargo(e: Empire) {
    this.sink.player(e.info.id, { t: 'cargo', c: this.cargoState(e) });
  }

  // ---------------------------------------------------------------- combat
  private ceaseFire(e: Empire) {
    this.attack(`e${e.info.id}`, null);
    this.flushAll();
  }

  /** Point a shooter at a target (or stand it down with null) and re-settle the drain on what changed. */
  private attack(key: string, target: Ref | null, dps = 0) {
    const prev = this.attacks.get(key);
    if (prev && target && sameRef(prev.target, target) && prev.dps === dps) return;
    if (target) this.attacks.set(key, { target, dps });
    else this.attacks.delete(key);
    if (prev) this.redrain(prev.target);
    if (target && !(prev && sameRef(prev.target, target))) this.redrain(target);
  }

  /** A target's drain is the sum of everything shooting it. */
  private redrain(t: Ref) {
    let drain = 0;
    const turrets: number[] = [];
    for (const [k, a] of this.attacks)
      if (sameRef(a.target, t)) {
        drain += a.dps;
        if (k[0] === 's') turrets.push(Number(k.slice(1)));
      }
    if ('s' in t) {
      const s = this.byId.get(t.s);
      if (s && s.drain !== drain) {
        this.settle(s, drain);
        this.upsertStruct(s);
      }
    } else {
      const q = this.squads.get(t.q);
      if (!q) return;
      if (q.drain !== drain) this.settle(q, drain);
      q.attackers = turrets;
      this.markSquad(q.id);
    }
  }

  /** Settle health at the current time, then change the rate: the only update clients need. */
  private settle(h: Health, drain: number) {
    const now = this.now();
    h.hp = hpOf(h, now);
    h.hpAt = now;
    h.drain = drain;
  }

  /** Stop every shot at a target that's gone. */
  private dropAttacksOn(t: Ref) {
    for (const [k, a] of [...this.attacks]) if (sameRef(a.target, t)) this.attacks.delete(k);
  }

  // ---------------------------------------------------------------- ground war
  private markSquad(id: number) {
    this.squadsDirty.add(id);
    this.dirty.squads.add(id);
  }

  /** March, fight, die: squads change state at a few moments, and only then does anything get sent. */
  private stepSquads(dt: number) {
    const now = this.now();
    for (const q of [...this.squads.values()]) {
      if (hpOf(q, now) <= 0) {
        this.killSquad(q, true);
        continue;
      }
      if (!this.byId.has(q.target)) {
        this.retarget(q);
        continue;
      }
      // Fewer troopers, less damage: the target's drain drops as they fall.
      if (now >= arriveAt(q)) this.attack(`q${q.id}`, { s: q.target }, aliveOf(q, now) * TROOPER_DPS);
    }
    this.engageAcc += dt;
    if (this.engageAcc >= 0.25) {
      this.engageAcc = 0;
      this.engage();
    }
  }

  /** Pulse Batteries pick the nearest enemy squad in range, and hold on to it while it stays there. */
  private engage() {
    const now = this.now();
    const pos = [...this.squads.values()].map((q) => ({ q, at: squadAt(q, now) }));
    for (const t of this.turrets) {
      const key = `s${t.id}`, cur = this.attacks.get(key);
      if (!pos.length && !cur) continue;
      const x = tileCenterX(t.col, t.row), y = tileCenterY(t.row);
      const inRange = (p: (typeof pos)[number]) => p.q.owner !== t.owner && Math.hypot(p.at.x - x, p.at.y - y) <= TURRET_RANGE;
      const held = cur && 'q' in cur.target ? pos.find((p) => 'q' in cur.target && p.q.id === cur.target.q) : undefined;
      if (held && inRange(held)) continue;
      let best: (typeof pos)[number] | null = null, bd = Infinity;
      if (progressOf(t, now) >= 1)
        for (const p of pos) {
          const d = Math.hypot(p.at.x - x, p.at.y - y);
          if (inRange(p) && d < bd) { bd = d; best = p; }
        }
      this.attack(key, best ? { q: best.q.id } : null, TURRET_DPS);
    }
  }

  /** The target fell: march on the nearest enemy structure close by, or stand down. */
  private retarget(q: Squad) {
    const now = this.now(), at = squadAt(q, now);
    this.attack(`q${q.id}`, null);
    const [col, row] = tileOf(at.x, at.y);
    let best: Structure | null = null, bd = RETARGET_RANGE;
    for (const [c, r] of hexesInRadius(col, row, Math.ceil(RETARGET_RANGE / 21))) {
      const s = this.structure(c, r);
      if (!s || s.owner === q.owner) continue;
      const d = Math.hypot(tileCenterX(c, r) - at.x, tileCenterY(r) - at.y);
      if (d < bd) { bd = d; best = s; }
    }
    const path = best && findPath(this, [col, row], [best.col, best.row]);
    if (!best || !path) {
      this.emit({ faction: q.owner, type: 'info', col, row, text: 'mech found no more targets and stood down' });
      return this.killSquad(q, false);
    }
    q.target = best.id;
    q.route = routeFrom(at.x, at.y, path);
    q.startAt = now;
    this.markSquad(q.id);
  }

  private killSquad(q: Squad, killed: boolean) {
    this.squads.delete(q.id);
    this.squadsDirty.delete(q.id);
    this.dirty.squads.delete(q.id);
    this.dirty.goneSquads.add(q.id);
    this.squadsGone.push(q.id);
    this.attack(`q${q.id}`, null);
    this.dropAttacksOn({ q: q.id });
    if (killed) this.emit({ faction: q.owner, type: 'info', ...tileObj(squadAt(q, this.now()).x, squadAt(q, this.now()).y), text: 'lost a mech' });
  }

  private sendSquads() {
    if (!this.squadsDirty.size && !this.squadsGone.length) return;
    const changed = [...this.squadsDirty].map((id) => ({ ...this.squads.get(id)! })), gone = this.squadsGone;
    this.squadsDirty.clear();
    this.squadsGone = [];
    this.sink.all({ t: 'squads', changed, gone });
  }

  /** Chunk deltas and squad changes go out together. */
  private flushAll() {
    this.flush();
    this.sendSquads();
  }

  /**
   * Ships stationed at `from` (a lost Hangar's id, or -1 for ships already
   * waiting) move to the empire's first standing Hangar, or wait (-1) until one
   * is built. Ships are never deleted with a building.
   */
  private rehome(e: Empire, from: number) {
    const hangars = [...e.structs].filter((h) => h.kind === 'hangar' && h.id !== from && progressOf(h, this.now()) >= 1);
    let moved = false;
    for (const sh of e.ships.values())
      if (sh.station === from) {
        sh.station = hangars[0]?.id ?? -1;
        this.dirty.ships.add(sh.id);
        moved = true;
      }
    if (moved) queueMicrotask(() => this.sendFleet(e));
  }

  private destroy(s: Structure) {
    this.dropAttacksOn({ s: s.id });
    this.attack(`s${s.id}`, null);
    this.bayReady.delete(s.id);
    this.removeStruct(s);
    const e = this.empires.get(s.owner);
    if (this.dropStore(s.id) && e) this.sendCargo(e);
    if (s.kind === 'hangar' && e) this.rehome(e, s.id);
    (this.delta(s.col, s.row).destroyed ??= []).push(localIndex(s.col, s.row));
    this.emit({ faction: s.owner, type: 'info', col: s.col, row: s.row, text: `lost a ${STRUCT[s.kind].name} to weapons fire` });
    if (e) this.sendPlayer(e);
  }

  // ---------------------------------------------------------------- WorldRead
  kindId(col: number, row: number) {
    const o = this.overrides.get(pack(col, row));
    if (o !== undefined) return o;
    const ck = chunkKeyOf(col, row);
    let t = this.terrain.get(ck);
    if (!t) {
      t = new Uint8Array(CHUNK_TILES);
      fillChunk(this.params, col >> CS_BITS, row >> CS_BITS, t);
      this.terrain.set(ck, t);
    }
    return t[localIndex(col, row)];
  }
  kind(col: number, row: number) {
    return KINDS[this.kindId(col, row)];
  }
  owner(col: number, row: number) {
    return this.owners.get(pack(col, row)) ?? -1;
  }
  structure(col: number, row: number) {
    return this.structs.get(pack(col, row)) ?? null;
  }
  empireName(id: number) {
    return this.empires.get(id)?.info.name ?? 'another empire';
  }

  // ---------------------------------------------------------------- mutation + change tracking
  private delta(col: number, row: number): ChunkDelta {
    const ck = chunkKeyOf(col, row);
    let d = this.pending.get(ck);
    if (!d) this.pending.set(ck, (d = { cx: col >> CS_BITS, cy: row >> CS_BITS, rev: 0 }));
    return d;
  }

  private setOwner(col: number, row: number, f: number) {
    const k = pack(col, row), prev = this.owners.get(k) ?? -1;
    if (prev === f) return;
    if (prev >= 0) this.empires.get(prev)?.tiles.delete(k);
    if (f >= 0) {
      this.owners.set(k, f);
      this.empires.get(f)?.tiles.add(k);
    } else this.owners.delete(k);
    (this.delta(col, row).owners ??= []).push([localIndex(col, row), f]);
    this.dirty.chunks.add(chunkKeyOf(col, row));
    this.ovDirty = true;
  }

  private setTerrain(col: number, row: number, kind: number) {
    this.overrides.set(pack(col, row), kind);
    (this.delta(col, row).terrain ??= []).push([localIndex(col, row), kind]);
    this.dirty.chunks.add(chunkKeyOf(col, row));
  }

  private upsertStruct(s: Structure) {
    const fresh = !this.byId.has(s.id);
    this.structs.set(pack(s.col, s.row), s);
    this.byId.set(s.id, s);
    if (fresh) {
      this.empires.get(s.owner)?.structs.add(s);
      if (s.kind === 'turret') this.turrets.add(s);
    }
    this.dirty.structs.add(s.id);
    (this.delta(s.col, s.row).upserts ??= []).push({ ...s });
  }

  private removeStruct(s: Structure) {
    const e = this.empires.get(s.owner);
    if (e && !this.building.has(s)) this.settleRes(e); // its production stops now
    this.structs.delete(pack(s.col, s.row));
    this.byId.delete(s.id);
    e?.structs.delete(s);
    this.turrets.delete(s);
    this.building.delete(s);
    this.dirty.structs.delete(s.id);
    this.dirty.goneStructs.add(s.id);
    (this.delta(s.col, s.row).removes ??= []).push(localIndex(s.col, s.row));
  }

  /** Close the current batch: one new revision per touched chunk, pushed to its watchers. */
  flush() {
    for (const [ck, d] of this.pending) {
      const rev = (this.revs.get(ck) ?? 0) + 1;
      this.revs.set(ck, rev);
      this.dirty.chunks.add(ck);
      d.rev = rev;
      this.sink.chunk(ck, { t: 'delta', d });
    }
    this.pending.clear();
  }

  /** Current state of chunks, for clients that just subscribed. Flushes first so the revs cover every pending change. */
  snapshots(keys: number[]): ChunkSnapshot[] {
    this.flushAll();
    return keys.map((k) => this.snapshot(k));
  }

  private snapshot(ck: number): ChunkSnapshot {
    const cx = unpackA(ck), cy = unpackB(ck);
    const owner = new Int32Array(CHUNK_TILES).fill(-1);
    const terrain: [number, number][] = [];
    const structures: Structure[] = [];
    let owned = false;
    for (let lr = 0; lr < CS; lr++)
      for (let lc = 0; lc < CS; lc++) {
        const k = pack(cx * CS + lc, cy * CS + lr), i = lr * CS + lc;
        const o = this.owners.get(k);
        if (o !== undefined) { owner[i] = o; owned = true; }
        const t = this.overrides.get(k);
        if (t !== undefined) terrain.push([i, t]);
        const s = this.structs.get(k);
        if (s) structures.push({ ...s });
      }
    return { cx, cy, rev: this.revs.get(ck) ?? 0, owner: owned ? owner : null, terrain, structures };
  }

  // ---------------------------------------------------------------- simulation
  step(dt: number) {
    const now = this.now();
    for (const s of this.building)
      if (now >= s.finishAt) {
        const e = this.empires.get(s.owner);
        if (e) this.settleRes(e);
        this.building.delete(s);
        this.complete(s, false);
      }
    // No damage ticks: health is a straight line, so just check whether whatever is under fire has reached zero.
    for (const a of [...this.attacks.values()])
      if ('s' in a.target) {
        const s = this.byId.get(a.target.s);
        if (s && hpOf(s, now) <= 0) this.destroy(s);
      }
    this.stepSquads(dt);
    for (const [k, at] of this.opened)
      if (now >= at) {
        this.opened.delete(k);
        this.setTerrain(unpackA(k), unpackB(k), KIND_ID.cache);
      }
    // Resources are lines too; the ticker only refreshes the numbers online players see.
    this.tickAcc += dt;
    if (this.tickAcc >= 1) {
      this.tickAcc = 0;
      for (const e of this.empires.values()) if (e.sessions) this.sendPlayer(e);
    }
    this.flushAll();
    this.ovAcc += dt;
    if (this.ovDirty && this.ovAcc > 2) {
      this.ovAcc = 0;
      this.ovDirty = false;
      this.sink.all({ t: 'overview', o: this.overviewWire() });
    }
  }

  // ---------------------------------------------------------------- economy
  private rates(e: Empire): Res {
    if (e.rateCache) return e.rateCache;
    const r = emptyRes();
    for (const s of e.structs) {
      if (this.building.has(s)) continue;
      const p = STRUCT[s.kind].produce(this.kind(s.col, s.row));
      for (const k of RES_KEYS) r[k] += p[k] ?? 0;
    }
    return (e.rateCache = r);
  }

  /** Resources right now, read off the line. Each runs dry at zero and stays there. */
  private resOf(e: Empire): Res {
    const r = this.rates(e), dt = this.now() - e.resAt, out = emptyRes();
    for (const k of RES_KEYS) out[k] = Math.max(0, e.res[k] + r[k] * dt);
    return out;
  }

  /** Fold the line into a new starting point before its slope changes. */
  private settleRes(e: Empire) {
    e.res = this.resOf(e);
    e.resAt = this.now();
    e.rateCache = null;
    this.dirty.empires.add(e.info.id);
  }

  private spend(e: Empire, cost: Partial<Res>) {
    this.settleRes(e);
    for (const k of RES_KEYS) e.res[k] -= cost[k] ?? 0;
  }

  private playerState(e: Empire): PlayerState {
    const res = this.resOf(e);
    for (const k of RES_KEYS) res[k] = Math.floor(res[k]);
    return { res, rates: { ...this.rates(e) }, sectors: e.tiles.size, structures: e.structs.size, cycle: this.cycle };
  }

  private sendPlayer(e: Empire) {
    if (e.sessions) this.sink.player(e.info.id, { t: 'player', p: this.playerState(e) });
  }

  private overviewWire() {
    const R = this.params.radiusPx, cell = OVERVIEW_CELL, w = Math.ceil((2 * R) / cell);
    const cells = new Map<number, number>();
    for (const [k, f] of this.owners) {
      const col = unpackA(k), row = unpackB(k);
      const cx = Math.floor((tileCenterX(col, row) + R) / cell), cy = Math.floor((tileCenterY(row) + R) / cell);
      if (cx >= 0 && cy >= 0 && cx < w && cy < w) cells.set(cy * w + cx, f);
    }
    const flat = new Int32Array(cells.size * 2);
    let i = 0;
    for (const [c, f] of cells) { flat[i++] = c; flat[i++] = f; }
    return { x0: -R, y0: -R, cell, w, h: w, cells: flat, version: ++this.ovVersion };
  }

  // ---------------------------------------------------------------- events
  /**
   * Interest management for the feed: an event about a place goes to whoever
   * watches that chunk, and always to the empire it's about. Clients drop
   * the duplicate when both apply (same event id).
   */
  private emit(e: Omit<WorldEvent, 'id' | 'cycle'>) {
    const ev: WorldEvent = { ...e, id: this.nextId++, cycle: this.cycle };
    this.log = [ev, ...this.log].slice(0, 200);
    if (ev.col !== undefined) this.sink.chunk(chunkKeyOf(ev.col, ev.row!), { t: 'event', e: ev });
    if (ev.faction >= 0) this.sink.player(ev.faction, { t: 'event', e: ev });
    else if (ev.col === undefined) this.sink.all({ t: 'event', e: ev });
  }

  /** Put a structure down. Public for tests and admin tooling; players go through build(). */
  place(kind: StructureKind, col: number, row: number, f: number, instant: boolean) {
    const now = this.now();
    const s: Structure = { id: this.nextId++, kind, owner: f, col, row, startedAt: now, finishAt: instant ? now : now + STRUCT[kind].buildTime, level: 1,
      hp: STRUCT[kind].hp, hpAt: now, drain: 0,
    };
    if (this.owner(col, row) === -1 && kind !== 'relay') this.setOwner(col, row, f);
    this.upsertStruct(s);
    if (instant) {
      const e = this.empires.get(f);
      if (e) this.settleRes(e);
      this.complete(s, true);
    } else this.building.add(s);
    return s;
  }

  private complete(s: Structure, silent: boolean) {
    const def = STRUCT[s.kind];
    const e = this.empires.get(s.owner);
    if (e) {
      if (s.kind === 'storage' || s.kind === 'hangar') queueMicrotask(() => this.sendCargo(e));
      if (s.kind === 'hangar') this.rehome(e, -1);
      e.rateCache = null;
    }
    let claimed = 0;
    if (def.claim)
      for (const [c, r] of hexesInRadius(s.col, s.row, def.claim))
        if (this.kindId(c, r) !== VOID && this.owner(c, r) === -1) { this.setOwner(c, r, s.owner); claimed++; }
    if (silent) return;
    this.emit({ faction: s.owner, type: 'online', col: s.col, row: s.row, text: `${def.name} is online` });
    if (claimed > 0) this.emit({ faction: s.owner, type: 'claim', col: s.col, row: s.row, text: `annexed ${claimed} sectors` });
  }

  private nearestLand(x: number, y: number) {
    const row0 = Math.round((y - 14) / 21), col0 = Math.round((x - 16 - (row0 & 1) * 16) / 32);
    for (let rad = 0; rad < 80; rad++)
      for (const [c, r] of hexesInRadius(col0, row0, rad)) if (this.kindId(c, r) !== VOID) return { col: c, row: r };
    return { col: col0, row: row0 };
  }

  private randomOwned(e: Empire, deposit: boolean): [number, number] | null {
    const out: [number, number][] = [];
    for (const k of e.tiles) {
      if (this.structs.has(k)) continue;
      const c = unpackA(k), r = unpackB(k);
      if (!deposit || TILE_INFO[this.kind(c, r)].deposit) out.push([c, r]);
    }
    return out.length ? out[Math.floor(this.rnd() * out.length)] : null;
  }

  /** Tiles bordering an empire's territory that nobody owns (tests and tooling). */
  frontier(id: number): [number, number][] {
    const seen = new Set<number>(), out: [number, number][] = [];
    for (const k of this.empires.get(id)?.tiles ?? []) {
      const col = unpackA(k), row = unpackB(k);
      for (let d = 0; d < 6; d++) {
        const [c, r] = neighbor(col, row, d), nk = pack(c, r);
        if (seen.has(nk)) continue;
        seen.add(nk);
        if (this.kindId(c, r) !== VOID && !this.owners.has(nk) && !this.structs.has(nk)) out.push([c, r]);
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- persistence
  /**
   * Hand over everything that changed since the last call, as plain rows. The
   * caller writes them in one transaction; if that fails, it must not call
   * again with fresh state, because these changes are gone from `dirty`.
   */
  takeChanges(): SectorChanges {
    const d = this.dirty;
    const empireRow = (e: Empire): EmpireRow => ({
      id: e.info.id, name: e.info.name, color: e.info.color, home: e.home, res: { ...e.res }, resAt: e.resAt, flying: e.flying, pos: { ...e.pos },
    });
    const chunkRow = (ck: number): ChunkRow => {
      const cx = unpackA(ck), cy = unpackB(ck), owners: [number, number][] = [], terrain: [number, number][] = [], opened: [number, number][] = [];
      for (let lr = 0; lr < CS; lr++)
        for (let lc = 0; lc < CS; lc++) {
          const k = pack(cx * CS + lc, cy * CS + lr), i = lr * CS + lc;
          const o = this.owners.get(k);
          if (o !== undefined) owners.push([i, o]);
          const t = this.overrides.get(k);
          if (t !== undefined) terrain.push([i, t]);
          const at = this.opened.get(k);
          if (at !== undefined) opened.push([i, at]);
        }
      return { ck, rev: this.revs.get(ck) ?? 0, owners, terrain, opened };
    };
    const containerRow = (key: string): ContainerRow | null => {
      const id = Number(key.slice(1));
      if (key[0] === 'h') {
        const owner = this.shipOwner.get(id);
        return owner === undefined ? null : { key, owner, items: structuredClone(this.holdOf(id)) };
      }
      const s = this.byId.get(id);
      return s ? { key, owner: s.owner, items: structuredClone(this.storeOf(id)) } : null;
    };
    const out: SectorChanges = {
      savedAt: this.now(),
      empires: [...d.empires].map((id) => this.empires.get(id)).filter((e): e is Empire => !!e).map(empireRow),
      goneEmpires: [...d.goneEmpires],
      structures: [...d.structs].map((id) => this.byId.get(id)).filter((s): s is Structure => !!s).map((s) => ({ ...s })),
      goneStructures: [...d.goneStructs],
      chunks: [...d.chunks].map(chunkRow),
      ships: [...d.ships].flatMap((id) => {
        const owner = this.shipOwner.get(id), rec = owner === undefined ? undefined : this.empires.get(owner)?.ships.get(id);
        return rec ? [{ ...structuredClone(rec), owner: owner! }] : [];
      }),
      goneShips: [...d.goneShips],
      containers: [...d.containers].map(containerRow).filter((c): c is ContainerRow => !!c),
      goneContainers: [...d.goneContainers],
      squads: [...d.squads].map((id) => this.squads.get(id)).filter((q): q is Squad => !!q).map((q) => ({ ...q })),
      goneSquads: [...d.goneSquads],
    };
    for (const set of Object.values(d)) set.clear();
    return out;
  }

  /** True when there's something for takeChanges() to hand over. */
  get hasChanges() {
    return Object.values(this.dirty).some((s) => s.size > 0);
  }

  /**
   * Rebuild from storage. Time kept running while the shard was down, so:
   * construction finishes on schedule (it's wall-clock, like any builder game);
   * resources accrued (offline production is a feature); but nobody was firing,
   * so health lines stop where they were at the last save, and squads resume
   * their march from where they stood.
   */
  private restore(data: SectorData) {
    const now = this.now(), down = Math.max(0, now - data.savedAt);
    for (const r of data.empires)
      this.empires.set(r.id, {
        id: r.id, info: { id: r.id, name: r.name, color: r.color }, home: r.home, res: { ...r.res }, resAt: r.resAt, rateCache: null, ships: new Map(),
        flying: r.flying, pos: { ...r.pos }, posAt: now, sessions: 0, tiles: new Set(), structs: new Set(),
      });
    for (const c of data.chunks) {
      const cx = unpackA(c.ck), cy = unpackB(c.ck);
      const at = (i: number) => pack(cx * CS + (i % CS), cy * CS + Math.floor(i / CS));
      this.revs.set(c.ck, c.rev);
      for (const [i, o] of c.owners) {
        this.owners.set(at(i), o);
        this.empires.get(o)?.tiles.add(at(i));
      }
      for (const [i, k] of c.terrain) this.overrides.set(at(i), k);
      for (const [i, t] of c.opened) this.opened.set(at(i), t);
    }
    for (const s of data.structures) {
      if (s.drain) {
        s.hp = hpOf(s, data.savedAt);
        s.hpAt = now;
        s.drain = 0;
      }
      this.structs.set(pack(s.col, s.row), s);
      this.byId.set(s.id, s);
      this.empires.get(s.owner)?.structs.add(s);
      if (s.kind === 'turret') this.turrets.add(s);
      // Unfinished at the last save: the first step completes it if it finished during the downtime (claims, events).
      if (s.finishAt > data.savedAt) this.building.add(s);
      this.nextId = Math.max(this.nextId, s.id + 1);
    }
    for (const sh of data.ships) {
      const { owner, ...rec } = sh;
      this.empires.get(owner)?.ships.set(rec.id, rec);
      this.shipOwner.set(rec.id, owner);
      this.nextItem = Math.max(this.nextItem, rec.id + 1);
    }
    for (const c of data.containers) {
      const id = Number(c.key.slice(1));
      (c.key[0] === 'h' ? this.holds : this.stores).set(id, c.items);
      for (const it of c.items) this.nextItem = Math.max(this.nextItem, it.uid + 1);
    }
    for (const q of data.squads) {
      q.hp = hpOf(q, data.savedAt);
      q.hpAt = now;
      q.drain = 0;
      q.startAt += down;
      q.attackers = [];
      this.squads.set(q.id, q);
      this.nextId = Math.max(this.nextId, q.id + 1);
    }
    // Health and positions were re-based; make sure the next save records that.
    for (const s of this.byId.values()) this.dirty.structs.add(s.id);
    for (const q of this.squads.values()) this.dirty.squads.add(q.id);
  }
}
