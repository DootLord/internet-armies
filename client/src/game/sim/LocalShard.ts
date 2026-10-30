// In-process stand-in for the authoritative Node shard. No DOM access, so it can
// move server-side largely as-is. State is sparse (Maps keyed by packed tile
// coords): cost scales with what players have built, not with map size.
import { BUILDABLE, emptyRes, FACTIONS, PLAYER, Res, RES_KEYS, STRUCT, StructureKind, TILE_INFO } from '../defs';
import { hexesInRadius, neighbor } from '../hex';
import { mulberry32 } from '../rng';
import { CHUNK_TILES, CS, CS_BITS, chunkKeyOf, localIndex, pack, unpackA, unpackB } from '../chunks';
import { fillChunk, KIND_ID, KINDS, TerrainParams, tileCenterX, tileCenterY, VOID } from '../terrain';
import { canBuild, WorldRead } from '../rules';
import { hpOf } from '../protocol';
import type {
  BuildCheck, ChunkDelta, ChunkSnapshot, FireOrder, Overview, PlayerState, SourceHandlers, Structure, WorldEvent, WorldMeta, WorldSource,
} from '../protocol';
import { computeStats, weaponStats } from '../ships/fitting';

export interface ShardOptions {
  seed: number;
  radiusPx: number;
  /** Simulated one-way network latency. 0 delivers synchronously (tests). */
  latencyMs?: number;
  /** Tests drive time themselves via step(); otherwise a 10 Hz timer runs. */
  manual?: boolean;
  clock?: () => number;
}

const OVERVIEW_CELL = 96;

export class LocalShard implements WorldSource, WorldRead {
  readonly params: TerrainParams;
  private terrain = new Map<number, Uint8Array>();
  private overrides = new Map<number, number>();
  private owners = new Map<number, number>();
  private structs = new Map<number, Structure>();
  private byId = new Map<number, Structure>();
  /** What the player is shooting. A real shard keeps one entry per shooter. */
  private firing: Structure | null = null;
  private building = new Set<Structure>();
  private factionTiles: Set<number>[] = FACTIONS.map(() => new Set());
  private factionStructs: Set<Structure>[] = FACTIONS.map(() => new Set());
  private revs = new Map<number, number>();
  private subs = new Set<number>();
  private pending = new Map<number, ChunkDelta>();
  private h: SourceHandlers | null = null;
  private res: Res = { credits: 900, alloy: 450, energy: 60, crystal: 40 };
  private rateCache: Res | null = null;
  private homes: { col: number; row: number }[] = [];
  private log: WorldEvent[] = [];
  private nextId = 1;
  private rnd: () => number;
  private aiTimer = 2;
  private tickAcc = 0;
  private ovAcc = 0;
  private ovDirty = true;
  private ovVersion = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private clock: () => number;
  private t0: number;
  private latency: number;

  constructor(o: ShardOptions) {
    this.params = { seed: o.seed, radiusPx: o.radiusPx };
    this.clock = o.clock ?? (() => performance.now() / 1000);
    this.t0 = this.clock();
    this.latency = o.latencyMs ?? 60;
    this.rnd = mulberry32(o.seed ^ 0x9e3779b9);
    this.generate();
    if (!o.manual) {
      let last = this.clock();
      this.timer = setInterval(() => {
        const t = this.clock();
        this.step(t - last);
        last = t;
      }, 100);
    }
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
  }

  now() {
    return this.clock() - this.t0;
  }

  private get cycle() {
    return 4127 + Math.floor(this.now() / 6);
  }

  /** Deliver to the client after the simulated latency. Constant delay keeps FIFO order. */
  private send(fn: (h: SourceHandlers) => void) {
    const h = this.h;
    if (!h) return;
    if (this.latency <= 0) fn(h);
    else setTimeout(() => fn(h), this.latency);
  }

  private reply<T>(v: T): Promise<T> {
    return new Promise((res) => (this.latency <= 0 ? res(v) : setTimeout(() => res(v), this.latency)));
  }

  // ---------------------------------------------------------------- WorldSource
  connect(h: SourceHandlers): Promise<WorldMeta> {
    this.h = h;
    this.sendPlayer();
    this.sendOverview();
    for (const e of [...this.log].reverse()) if (this.visibleEvent(e)) this.send((x) => x.event(e));
    return this.reply({ seed: this.params.seed, radiusPx: this.params.radiusPx, homes: this.homes, player: PLAYER });
  }

  subscribe(keys: number[]) {
    this.flush(); // so the snapshot's rev already covers every pending change
    for (const k of keys) {
      this.subs.add(k);
      const snap = this.snapshot(k);
      this.send((h) => h.chunk(snap));
    }
  }

  unsubscribe(keys: number[]) {
    for (const k of keys) this.subs.delete(k);
  }

  build(kind: StructureKind, col: number, row: number): Promise<BuildCheck> {
    const r = canBuild(this, kind, col, row, PLAYER, this.res);
    if (r.ok) {
      for (const k of RES_KEYS) this.res[k] -= STRUCT[kind].cost[k] ?? 0;
      this.place(kind, col, row, PLAYER, false);
      this.emit({ faction: PLAYER, type: 'build', col, row, text: `began construction of ${STRUCT[kind].name}` });
      this.sendPlayer();
    }
    return this.reply(r);
  }

  demolish(col: number, row: number): Promise<BuildCheck> {
    const s = this.structure(col, row);
    let r: BuildCheck = { ok: true };
    if (!s || s.owner !== PLAYER) r = { ok: false, reason: 'Nothing to demolish' };
    else if (s.kind === 'nexus') r = { ok: false, reason: 'The Nexus cannot be demolished' };
    else {
      const cost = STRUCT[s.kind].cost;
      for (const k of RES_KEYS) this.res[k] += Math.floor((cost[k] ?? 0) * 0.5);
      this.removeStruct(s);
      this.emit({ faction: PLAYER, type: 'info', col, row, text: `decommissioned ${STRUCT[s.kind].name}` });
      this.sendPlayer();
    }
    return this.reply(r);
  }

  fire(order: FireOrder | null): Promise<BuildCheck> {
    this.ceaseFire();
    if (!order) return this.reply({ ok: true });
    const s = this.byId.get(order.target);
    if (!s) return this.reply({ ok: false, reason: 'Target lost' });
    // Recompute damage from the fit with the shared rules: never trust a number from the client.
    const st = computeStats(order.hull, order.fit);
    if (st.cpuUsed > st.cpu + 1e-9 || st.powerUsed > st.power + 1e-9) return this.reply({ ok: false, reason: 'Invalid fit' });
    const w = weaponStats(order.hull, order.fit, 'pulse-laser');
    if (!w.count) return this.reply({ ok: false, reason: 'No Pulse Laser fitted' });
    if (Math.hypot(tileCenterX(s.col, s.row) - order.x, tileCenterY(s.row) - order.y) > w.range) return this.reply({ ok: false, reason: 'Out of range' });
    this.setDrain(s, w.dps);
    this.firing = s;
    this.flush();
    return this.reply({ ok: true });
  }

  private ceaseFire() {
    if (this.firing && this.byId.has(this.firing.id)) this.setDrain(this.firing, 0);
    this.firing = null;
    this.flush();
  }

  /** Settle health at the current time, then change the rate: the only update clients need. */
  private setDrain(s: Structure, drain: number) {
    const now = this.now();
    s.hp = hpOf(s, now);
    s.hpAt = now;
    s.drain = drain;
    this.upsertStruct(s);
  }

  private destroy(s: Structure) {
    if (this.firing === s) this.firing = null;
    this.removeStruct(s);
    (this.delta(s.col, s.row).destroyed ??= []).push(localIndex(s.col, s.row));
    this.emit({ faction: s.owner, type: 'info', col: s.col, row: s.row, text: `lost a ${STRUCT[s.kind].name} to weapons fire` });
    if (s.owner === PLAYER) this.sendPlayer();
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
    if (prev >= 0) this.factionTiles[prev].delete(k);
    if (f >= 0) {
      this.owners.set(k, f);
      this.factionTiles[f].add(k);
    } else this.owners.delete(k);
    (this.delta(col, row).owners ??= []).push([localIndex(col, row), f]);
    this.ovDirty = true;
  }

  private setTerrain(col: number, row: number, kind: number) {
    this.overrides.set(pack(col, row), kind);
    (this.delta(col, row).terrain ??= []).push([localIndex(col, row), kind]);
  }

  private upsertStruct(s: Structure) {
    this.structs.set(pack(s.col, s.row), s);
    this.byId.set(s.id, s);
    this.factionStructs[s.owner].add(s);
    if (s.owner === PLAYER) this.rateCache = null;
    (this.delta(s.col, s.row).upserts ??= []).push({ ...s });
  }

  private removeStruct(s: Structure) {
    this.structs.delete(pack(s.col, s.row));
    this.byId.delete(s.id);
    this.factionStructs[s.owner].delete(s);
    this.building.delete(s);
    if (s.owner === PLAYER) this.rateCache = null;
    (this.delta(s.col, s.row).removes ??= []).push(localIndex(s.col, s.row));
  }

  /** Close the current batch: one new revision per touched chunk, pushed to subscribers. */
  flush() {
    for (const [ck, d] of this.pending) {
      const rev = (this.revs.get(ck) ?? 0) + 1;
      this.revs.set(ck, rev);
      if (this.subs.has(ck)) {
        d.rev = rev;
        this.send((h) => h.delta(d));
      }
    }
    this.pending.clear();
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
    for (const s of this.building) if (now >= s.finishAt) { this.building.delete(s); this.complete(s, false); }
    // No damage ticks: health is a straight line, so just check whether it has reached zero.
    if (this.firing && !this.byId.has(this.firing.id)) this.firing = null;
    if (this.firing && hpOf(this.firing, now) <= 0) this.destroy(this.firing);
    this.tickAcc += dt;
    while (this.tickAcc >= 1) {
      this.tickAcc -= 1;
      const r = this.rates();
      for (const k of RES_KEYS) this.res[k] = Math.max(0, this.res[k] + r[k]);
      this.sendPlayer();
    }
    this.aiTimer -= dt;
    if (this.aiTimer <= 0) {
      this.aiTimer = 1 + this.rnd() * 2.5;
      this.aiBuild(1 + Math.floor(this.rnd() * (FACTIONS.length - 1)), false);
    }
    this.flush();
    this.ovAcc += dt;
    if (this.ovDirty && this.ovAcc > 2) this.sendOverview();
  }

  private rates(): Res {
    if (this.rateCache) return this.rateCache;
    const r = emptyRes();
    for (const s of this.factionStructs[PLAYER]) {
      if (this.building.has(s)) continue;
      const p = STRUCT[s.kind].produce(this.kind(s.col, s.row));
      for (const k of RES_KEYS) r[k] += p[k] ?? 0;
    }
    return (this.rateCache = r);
  }

  private sendPlayer() {
    const p: PlayerState = {
      res: { ...this.res },
      rates: { ...this.rates() },
      sectors: this.factionTiles[PLAYER].size,
      structures: this.factionStructs[PLAYER].size,
      cycle: this.cycle,
    };
    this.send((h) => h.player(p));
  }

  private sendOverview() {
    this.ovAcc = 0;
    this.ovDirty = false;
    const R = this.params.radiusPx, cell = OVERVIEW_CELL, w = Math.ceil((2 * R) / cell);
    const owner = new Int32Array(w * w).fill(-1);
    for (const [k, f] of this.owners) {
      const col = unpackA(k), row = unpackB(k);
      const cx = Math.floor((tileCenterX(col, row) + R) / cell), cy = Math.floor((tileCenterY(row) + R) / cell);
      if (cx >= 0 && cy >= 0 && cx < w && cy < w) owner[cy * w + cx] = f;
    }
    const ov: Overview = { x0: -R, y0: -R, cell, w, h: w, owner, version: ++this.ovVersion };
    this.send((h) => h.overview(ov));
  }

  private visibleEvent(e: WorldEvent) {
    return e.faction === PLAYER || e.col === undefined || this.subs.has(chunkKeyOf(e.col, e.row!));
  }

  private emit(e: Omit<WorldEvent, 'id' | 'cycle'>) {
    const ev: WorldEvent = { ...e, id: this.nextId++, cycle: this.cycle };
    this.log = [ev, ...this.log].slice(0, 40);
    // Interest management for chat too: you hear about your own actions and what's near you.
    if (this.visibleEvent(ev)) this.send((h) => h.event(ev));
  }

  private place(kind: StructureKind, col: number, row: number, f: number, instant: boolean) {
    const now = this.now();
    const s: Structure = { id: this.nextId++, kind, owner: f, col, row, startedAt: now, finishAt: instant ? now : now + STRUCT[kind].buildTime, level: 1,
      hp: STRUCT[kind].hp, hpAt: now, drain: 0,
    };
    if (this.owner(col, row) === -1 && kind !== 'relay') this.setOwner(col, row, f);
    this.upsertStruct(s);
    if (instant) this.complete(s, true);
    else this.building.add(s);
  }

  private complete(s: Structure, silent: boolean) {
    const def = STRUCT[s.kind];
    if (s.owner === PLAYER) this.rateCache = null;
    let claimed = 0;
    if (def.claim)
      for (const [c, r] of hexesInRadius(s.col, s.row, def.claim))
        if (this.kindId(c, r) !== VOID && this.owner(c, r) === -1) { this.setOwner(c, r, s.owner); claimed++; }
    if (silent) return;
    this.emit({ faction: s.owner, type: 'online', col: s.col, row: s.row, text: `${def.name} is online` });
    if (claimed > 0) this.emit({ faction: s.owner, type: 'claim', col: s.col, row: s.row, text: `annexed ${claimed} sectors` });
  }

  // ---------------------------------------------------------------- world setup + placeholder AI
  private generate() {
    const R = this.params.radiusPx, n = FACTIONS.length;
    FACTIONS.forEach((f, i) => {
      // Sunflower spiral spreads homes evenly over the disc; the player starts central.
      const r = Math.sqrt(i / n) * 0.8 * R, a = i * 2.39996;
      const home = this.nearestLand(Math.cos(a) * r, Math.sin(a) * r);
      this.homes[f.id] = home;
      for (const [c, rr] of hexesInRadius(home.col, home.row, 2)) if (this.kindId(c, rr) === VOID) this.setTerrain(c, rr, KIND_ID.plate);
      this.place('nexus', home.col, home.row, f.id, true);
    });

    const mine = [...this.factionTiles[PLAYER]].map((k) => [unpackA(k), unpackB(k)] as [number, number]).filter(([c, r]) => !this.structure(c, r));
    if (!mine.some(([c, r]) => TILE_INFO[this.kind(c, r)].deposit)) this.setTerrain(...mine[mine.length - 1], KIND_ID.ore);
    const solar = this.randomOwned(PLAYER, false);
    if (solar) this.place('solar', solar[0], solar[1], PLAYER, true);

    for (let f = 1; f < n; f++) {
      const relays = 3 + Math.floor(this.rnd() * 3);
      for (let i = 0; i < relays; i++) {
        const fr = this.frontier(f);
        if (fr.length) this.place('relay', ...this.choose(fr), f, true);
      }
      const builds = 8 + Math.floor(this.rnd() * 6);
      for (let i = 0; i < builds; i++) this.aiBuild(f, true);
    }
    this.flush();
    this.log = [];
    this.emit({ faction: -1, type: 'info', text: 'Uplink established. Welcome to Kestrel Cluster, Commander.' });
  }

  private nearestLand(x: number, y: number) {
    const row0 = Math.round((y - 14) / 21), col0 = Math.round((x - 16 - (row0 & 1) * 16) / 32);
    for (let rad = 0; rad < 80; rad++)
      for (const [c, r] of hexesInRadius(col0, row0, rad)) if (this.kindId(c, r) !== VOID) return { col: c, row: r };
    return { col: col0, row: row0 };
  }

  private choose<T>(a: T[]): T {
    return a[Math.floor(this.rnd() * a.length)];
  }

  private frontier(f: number): [number, number][] {
    const seen = new Set<number>(), out: [number, number][] = [];
    for (const k of this.factionTiles[f]) {
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

  private randomOwned(f: number, deposit: boolean): [number, number] | null {
    const out: [number, number][] = [];
    for (const k of this.factionTiles[f]) {
      if (this.structs.has(k)) continue;
      const c = unpackA(k), r = unpackB(k);
      if (!deposit || TILE_INFO[this.kind(c, r)].deposit) out.push([c, r]);
    }
    return out.length ? this.choose(out) : null;
  }

  private aiBuild(f: number, instant: boolean) {
    if (this.factionStructs[f].size > 90) return;
    if (!instant && this.rnd() < 0.3 && this.factionTiles[f].size < 900) {
      const fr = this.frontier(f);
      if (fr.length) {
        const [c, r] = this.choose(fr);
        this.place('relay', c, r, f, false);
        this.emit({ faction: f, type: 'build', col: c, row: r, text: 'is deploying a Claim Relay' });
      }
      return;
    }
    const def = this.choose(BUILDABLE.filter((d) => d.place !== 'frontier'));
    const spot = this.randomOwned(f, def.place === 'deposit');
    if (!spot) return;
    this.place(def.kind, spot[0], spot[1], f, instant);
    if (!instant) this.emit({ faction: f, type: 'build', col: spot[0], row: spot[1], text: `began construction of ${def.name}` });
  }
}
