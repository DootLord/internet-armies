import { BUILDABLE, emptyRes, FACTIONS, PLAYER, Res, RES_INFO, RES_KEYS, STRUCT, StructureKind, TILE_INFO, TileKind } from './defs';
import { hexesInRadius, neighbor, RH, TW } from './hex';
import { fbm, hash2, mulberry32 } from './rng';

export interface Structure {
  id: number;
  kind: StructureKind;
  owner: number;
  col: number;
  row: number;
  /** 0..1 construction progress; 1 = online. */
  progress: number;
  level: number;
}

export interface Tile {
  col: number;
  row: number;
  kind: TileKind;
  variant: number;
  owner: number;
  structure: Structure | null;
  seed: number;
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

export interface BuildCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Client-side stand-in for the persistent shard. Everything here is meant to
 * move to the Node/socket.io server later; the client will just mirror state.
 */
export class World {
  readonly cols = 84;
  readonly rows = 108;
  readonly pxW = this.cols * TW + 16;
  readonly pxH = this.rows * RH + 7;
  tiles: Tile[] = [];
  structures: Structure[] = [];
  res: Res = { credits: 900, alloy: 450, energy: 60, crystal: 40 };
  homes: { col: number; row: number }[] = [];
  log: WorldEvent[] = [];
  time = 0;
  cycle = 4127;
  /** Bumped whenever territory or structures change (minimap, rate caches). */
  version = 0;

  private nextId = 1;
  private aiTimer = 2;
  private tickAcc = 0;
  private cycleAcc = 0;
  private rateCache = new Map<number, { v: number; r: Res }>();
  private rnd: () => number;
  private listeners = new Set<(e: WorldEvent) => void>();

  constructor(readonly seed: number) {
    this.rnd = mulberry32(seed ^ 0x9e3779b9);
    this.generate();
  }

  tile(col: number, row: number): Tile | null {
    if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) return null;
    return this.tiles[row * this.cols + col];
  }

  onEvent(fn: (e: WorldEvent) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: Omit<WorldEvent, 'id' | 'cycle'>) {
    const ev: WorldEvent = { ...e, id: this.nextId++, cycle: this.cycle };
    this.log = [ev, ...this.log].slice(0, 40);
    this.listeners.forEach((fn) => fn(ev));
  }

  // ---------------------------------------------------------------- generation
  private generate() {
    const { cols, rows, seed } = this;
    const W = cols * TW, H = rows * RH;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const x = col * TW + (row & 1) * 16 + 16, y = row * RH + 14;
        const nx = (x / W - 0.5) * 2, ny = (y / H - 0.5) * 2;
        const d = Math.sqrt(nx * nx * 0.92 + ny * ny);
        const n = fbm(x * 0.0032, y * 0.0032, seed, 5);
        const v = 1 - d + (n - 0.5) * 1.1;
        let kind: TileKind = 'void';
        const rift = Math.abs(fbm(x * 0.005, y * 0.005, seed + 11, 4) - 0.5) < 0.016;
        const hole = fbm(x * 0.018, y * 0.018, seed + 5, 3) > 0.7;
        if (v > 0.2 && !rift && !hole) {
          const biome = fbm(x * 0.0042, y * 0.0042, seed + 21, 4);
          const plate = fbm(x * 0.011, y * 0.011, seed + 31, 3);
          const r = hash2(col, row, seed + 3);
          if (biome < 0.4) kind = r < 0.6 ? 'ice' : r < 0.7 ? 'ore' : 'rock';
          else if (biome > 0.57) kind = r < 0.38 ? 'crystal' : r < 0.58 ? 'gas' : 'rock';
          else if (plate > 0.53) kind = r < 0.05 ? 'ruin' : 'plate';
          else kind = r < 0.16 ? 'ore' : r < 0.2 ? 'ruin' : 'rock';
        }
        this.tiles.push({ col, row, kind, variant: Math.floor(hash2(col, row, seed + 9) * 4), owner: -1, structure: null, seed: hash2(row, col, seed + 1) });
      }
    }

    const spots: [number, number][] = [[0.47, 0.55], [0.24, 0.28], [0.74, 0.26], [0.8, 0.7], [0.26, 0.78]];
    FACTIONS.forEach((f, i) => {
      const home = this.nearestLand(Math.round(spots[i][0] * cols), Math.round(spots[i][1] * rows));
      this.homes[f.id] = home;
      for (const [c, r] of hexesInRadius(home.col, home.row, 2)) {
        const t = this.tile(c, r);
        if (t && t.kind === 'void') t.kind = 'plate';
      }
      this.place('nexus', home.col, home.row, f.id, true);
    });

    // Make sure the player has something to drill.
    const mine = this.ownedTiles(PLAYER).filter((t) => !t.structure);
    if (!mine.some((t) => TILE_INFO[t.kind].deposit)) mine[mine.length - 1].kind = 'ore';
    this.place('solar', ...this.pickOwned(PLAYER, 'owned')!, PLAYER, true);

    for (let f = 1; f < FACTIONS.length; f++) {
      for (let i = 0; i < 2; i++) {
        const fr = this.frontier(f);
        if (fr.length) this.place('relay', ...this.choose(fr), f, true);
      }
      const n = 7 + Math.floor(this.rnd() * 5);
      for (let i = 0; i < n; i++) this.aiBuild(f, true);
    }
    this.log = [];
    this.emit({ faction: -1, type: 'info', text: 'Uplink established. Welcome to Kestrel Cluster, Commander.' });
  }

  private nearestLand(col: number, row: number) {
    let best = { col, row }, bd = Infinity;
    for (const t of this.tiles) {
      if (t.kind === 'void') continue;
      const d = (t.col - col) ** 2 + (t.row - row) ** 2;
      if (d < bd) { bd = d; best = { col: t.col, row: t.row }; }
    }
    return best;
  }

  // ---------------------------------------------------------------- territory
  ownedTiles(f: number) {
    return this.tiles.filter((t) => t.owner === f);
  }

  isAdjacentTo(col: number, row: number, f: number) {
    for (let d = 0; d < 6; d++) if (this.tile(...neighbor(col, row, d))?.owner === f) return true;
    return false;
  }

  frontier(f: number): [number, number][] {
    return this.tiles
      .filter((t) => t.kind !== 'void' && t.owner === -1 && !t.structure && this.isAdjacentTo(t.col, t.row, f))
      .map((t) => [t.col, t.row]);
  }

  private claim(f: number, col: number, row: number, radius: number) {
    let n = 0;
    for (const [c, r] of hexesInRadius(col, row, radius)) {
      const t = this.tile(c, r);
      if (t && t.kind !== 'void' && t.owner === -1) { t.owner = f; n++; }
    }
    this.version++;
    return n;
  }

  // ---------------------------------------------------------------- building
  canBuild(kind: StructureKind, col: number, row: number, f = PLAYER): BuildCheck {
    const t = this.tile(col, row);
    const def = STRUCT[kind];
    if (!t || t.kind === 'void') return { ok: false, reason: 'No solid ground' };
    if (t.structure) return { ok: false, reason: 'Sector occupied' };
    if (def.place === 'none') return { ok: false, reason: 'Cannot be built' };
    if (def.place === 'frontier') {
      if (t.owner === f) return { ok: false, reason: 'Must be outside your borders' };
      if (t.owner !== -1) return { ok: false, reason: `Claimed by ${FACTIONS[t.owner].name}` };
      if (!this.isAdjacentTo(col, row, f)) return { ok: false, reason: 'Must border your territory' };
    } else {
      if (t.owner === -1) return { ok: false, reason: 'Outside your territory' };
      if (t.owner !== f) return { ok: false, reason: `Claimed by ${FACTIONS[t.owner].name}` };
      if (def.place === 'deposit' && !TILE_INFO[t.kind].deposit) return { ok: false, reason: 'Requires a resource deposit' };
    }
    if (f === PLAYER) {
      for (const k of RES_KEYS) if (this.res[k] < (def.cost[k] ?? 0)) return { ok: false, reason: `Insufficient ${RES_INFO[k].name.toLowerCase()}` };
    }
    return { ok: true };
  }

  build(kind: StructureKind, col: number, row: number, f = PLAYER): BuildCheck {
    const check = this.canBuild(kind, col, row, f);
    if (!check.ok) return check;
    if (f === PLAYER) for (const k of RES_KEYS) this.res[k] -= STRUCT[kind].cost[k] ?? 0;
    this.place(kind, col, row, f, false);
    this.emit({ faction: f, type: 'build', col, row, text: `began construction of ${STRUCT[kind].name}` });
    return check;
  }

  private place(kind: StructureKind, col: number, row: number, f: number, instant: boolean) {
    const t = this.tile(col, row)!;
    const s: Structure = { id: this.nextId++, kind, owner: f, col, row, progress: instant ? 1 : 0, level: 1 };
    t.structure = s;
    if (t.owner === -1 && kind !== 'relay') t.owner = f;
    this.structures.push(s);
    this.version++;
    if (instant) this.complete(s, true);
    return s;
  }

  private complete(s: Structure, silent: boolean) {
    const def = STRUCT[s.kind];
    let claimed = 0;
    if (def.claim) claimed = this.claim(s.owner, s.col, s.row, def.claim);
    this.version++;
    if (silent) return;
    this.emit({ faction: s.owner, type: 'online', col: s.col, row: s.row, text: `${def.name} is online` });
    if (claimed > 0) this.emit({ faction: s.owner, type: 'claim', col: s.col, row: s.row, text: `annexed ${claimed} sectors` });
  }

  demolish(col: number, row: number): BuildCheck {
    const t = this.tile(col, row);
    const s = t?.structure;
    if (!t || !s || s.owner !== PLAYER) return { ok: false, reason: 'Nothing to demolish' };
    if (s.kind === 'nexus') return { ok: false, reason: 'The Nexus cannot be demolished' };
    const cost = STRUCT[s.kind].cost;
    for (const k of RES_KEYS) this.res[k] += Math.floor((cost[k] ?? 0) * 0.5);
    t.structure = null;
    this.structures = this.structures.filter((x) => x !== s);
    this.version++;
    this.emit({ faction: PLAYER, type: 'info', col, row, text: `decommissioned ${STRUCT[s.kind].name}` });
    return { ok: true };
  }

  rates(f = PLAYER): Res {
    const cached = this.rateCache.get(f);
    if (cached && cached.v === this.version) return cached.r;
    const r = emptyRes();
    for (const s of this.structures) {
      if (s.owner !== f || s.progress < 1) continue;
      const p = STRUCT[s.kind].produce(this.tile(s.col, s.row)!.kind);
      for (const k of RES_KEYS) r[k] += p[k] ?? 0;
    }
    this.rateCache.set(f, { v: this.version, r });
    return r;
  }

  // ---------------------------------------------------------------- simulation
  update(dt: number) {
    this.time += dt;
    for (const s of this.structures) {
      if (s.progress >= 1) continue;
      s.progress = Math.min(1, s.progress + dt / STRUCT[s.kind].buildTime);
      if (s.progress >= 1) this.complete(s, false);
    }
    this.tickAcc += dt;
    while (this.tickAcc >= 1) {
      this.tickAcc -= 1;
      const r = this.rates(PLAYER);
      for (const k of RES_KEYS) this.res[k] = Math.max(0, this.res[k] + r[k]);
    }
    this.cycleAcc += dt;
    if (this.cycleAcc > 6) { this.cycleAcc = 0; this.cycle++; }
    this.aiTimer -= dt;
    if (this.aiTimer <= 0) {
      this.aiTimer = 2.5 + this.rnd() * 4;
      this.aiBuild(1 + Math.floor(this.rnd() * (FACTIONS.length - 1)), false);
    }
  }

  private choose<T>(a: T[]): T {
    return a[Math.floor(this.rnd() * a.length)];
  }

  private pickOwned(f: number, place: 'owned' | 'deposit'): [number, number] | null {
    const c = this.ownedTiles(f).filter((t) => !t.structure && (place === 'owned' || TILE_INFO[t.kind].deposit));
    if (!c.length) return null;
    const t = this.choose(c);
    return [t.col, t.row];
  }

  /** Placeholder AI so the shared map feels inhabited until real players connect. */
  private aiBuild(f: number, instant: boolean) {
    const owned = this.ownedTiles(f).length;
    const count = this.structures.filter((s) => s.owner === f).length;
    if (count > 70) return;
    if (!instant && this.rnd() < 0.28 && owned < 240) {
      const fr = this.frontier(f);
      if (fr.length) {
        const [c, r] = this.choose(fr);
        this.place('relay', c, r, f, false);
        this.emit({ faction: f, type: 'build', col: c, row: r, text: 'is deploying a Claim Relay' });
      }
      return;
    }
    const opts = BUILDABLE.filter((d) => d.place !== 'frontier');
    const def = this.choose(opts);
    const spot = this.pickOwned(f, def.place === 'deposit' ? 'deposit' : 'owned');
    if (!spot) return;
    this.place(def.kind, spot[0], spot[1], f, instant);
    if (!instant) this.emit({ faction: f, type: 'build', col: spot[0], row: spot[1], text: `began construction of ${def.name}` });
  }
}
