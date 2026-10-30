// The client's picture of the world: a cache of chunks around the camera, kept
// in sync with the shard by subscriptions. No DOM here, so it runs under tests.
//
//   viewport ──► want set (visible + 1 ring) ──► subscribe / unsubscribe (with hysteresis)
//   snapshot ──► chunk.rev = n          delta(rev n+1) ──► apply     delta(rev ≠ n+1) ──► resync
import { emptyRes, StructureKind, TileKind } from './defs';
import { Chunk, CHUNK_PX_H, CHUNK_PX_W, chunkKeyOf, localIndex, pack } from './chunks';
import { fillChunk, KINDS, TerrainParams } from './terrain';
import { canBuild, isAdjacentTo, WorldRead } from './rules';
import type { Fit } from './ships/fitting';
import type { FleetState } from './ships/fleet';
import type { BuildCheck, CargoOp, CargoState, ChunkDelta, FireOrder, ShipReport, ChunkSnapshot, Overview, PlayerState, Squad, Structure, WorldEvent, WorldMeta, WorldSource } from './protocol';

/** Beyond this many chunks in view, stop per-chunk streaming and rely on the overview. */
export const MAX_DETAIL_CHUNKS = 300;
/** Cached chunks kept after leaving view (terrain + last known state), LRU-evicted. */
export const MAX_CACHED_CHUNKS = 1200;

export interface Rect { x: number; y: number; w: number; h: number }

export interface ViewStats {
  cached: number;
  subscribed: number;
  awaiting: number;
  genQueue: number;
  resyncs: number;
  deltas: number;
  snapshots: number;
  detail: boolean;
}

export interface ViewListeners {
  event?: (e: WorldEvent) => void;
  player?: (p: PlayerState) => void;
  overview?: (o: Overview) => void;
  /** A structure in a watched chunk was destroyed by fire (not demolished). */
  destroyed?: (s: Structure) => void;
  cargo?: (c: CargoState) => void;
  fleet?: (f: FleetState) => void;
  /** A squad vanished: killed (its health ran out) or stood down. */
  squadGone?: (q: Squad) => void;
}

export class WorldView implements WorldRead {
  readonly chunks = new Map<number, Chunk>();
  /** Structures in cached chunks, by id. */
  readonly structures = new Map<number, Structure>();
  meta: WorldMeta | null = null;
  params: TerrainParams = { seed: 0, radiusPx: 1 };
  player: PlayerState = { res: emptyRes(), rates: emptyRes(), sectors: 0, structures: 0, cycle: 0 };
  overview: Overview | null = null;
  /** The player's holds and Storage contents, as the shard last reported them. */
  cargo: CargoState | null = null;
  /** The player's ships, as the shard last reported them. */
  fleet: FleetState | null = null;
  /** Every squad on the map. Few enough to send them all for now; a real shard would filter by interest. */
  readonly squads = new Map<number, Squad>();
  log: WorldEvent[] = [];
  listeners: ViewListeners = {};
  detail = true;
  readonly stats: ViewStats = { cached: 0, subscribed: 0, awaiting: 0, genQueue: 0, resyncs: 0, deltas: 0, snapshots: 0, detail: true };

  private subscribed = new Set<number>();
  private genQueue = new Set<Chunk>();
  private frame = 0;

  constructor(readonly source: WorldSource) {}

  async connect() {
    this.meta = await this.source.connect({
      chunk: (s) => this.onSnapshot(s),
      delta: (d) => this.onDelta(d),
      cargo: (c) => {
        this.cargo = c;
        this.listeners.cargo?.(c);
      },
      fleet: (f) => {
        this.fleet = f;
        this.listeners.fleet?.(f);
      },
      squads: (changed, gone) => {
        for (const q of changed) this.squads.set(q.id, q);
        for (const id of gone) {
          const q = this.squads.get(id);
          this.squads.delete(id);
          if (q) this.listeners.squadGone?.(q);
        }
      },
      player: (p) => {
        this.player = p;
        this.listeners.player?.(p);
      },
      overview: (o) => {
        this.overview = o;
        this.listeners.overview?.(o);
      },
      event: (e) => {
        this.log = [e, ...this.log].slice(0, 40);
        this.listeners.event?.(e);
      },
    });
    this.params = { seed: this.meta.seed, radiusPx: this.meta.radiusPx };
    return this.meta;
  }

  now() {
    return this.source.now();
  }

  // ---------------------------------------------------------------- reads (hot path)
  chunkAt(col: number, row: number) {
    return this.chunks.get(chunkKeyOf(col, row));
  }
  kind(col: number, row: number): TileKind | null {
    const c = this.chunkAt(col, row);
    return c && c.terrainReady ? KINDS[c.kind[localIndex(col, row)]] : null;
  }
  owner(col: number, row: number) {
    const c = this.chunkAt(col, row);
    return c ? c.owner[localIndex(col, row)] : -1;
  }
  structure(col: number, row: number) {
    return this.chunkAt(col, row)?.structures.get(localIndex(col, row)) ?? null;
  }
  /** Do we have authoritative state (not just terrain) for this tile? */
  known(col: number, row: number) {
    const c = this.chunkAt(col, row);
    return !!c && c.terrainReady && c.stateReady;
  }

  isAdjacentTo(col: number, row: number, f: number) {
    return isAdjacentTo(this, col, row, f);
  }

  /** Client-side prediction for instant feedback; the shard re-checks everything. */
  canBuild(kind: StructureKind, col: number, row: number): BuildCheck {
    if (!this.known(col, row)) return { ok: false, reason: 'Sector data still loading' };
    return canBuild(this, kind, col, row, this.meta?.player ?? 0, this.player.res);
  }

  build(kind: StructureKind, col: number, row: number) {
    return this.source.build(kind, col, row);
  }

  demolish(col: number, row: number) {
    return this.source.demolish(col, row);
  }

  fire(order: FireOrder | null) {
    return this.source.fire(order);
  }

  cargoOp(op: CargoOp, ship: ShipReport) {
    return this.source.cargo(op, ship);
  }

  openCache(col: number, row: number, ship: ShipReport) {
    return this.source.openCache(col, row, ship);
  }

  board(shipId: number, ship: ShipReport) {
    return this.source.board(shipId, ship);
  }

  refit(shipId: number, fit: Fit, ship: ShipReport) {
    return this.source.refit(shipId, fit, ship);
  }

  deploy(bay: number, target: number) {
    return this.source.deploy(bay, target);
  }

  // ---------------------------------------------------------------- streaming
  /**
   * Call once per frame with the visible world rect. Decides what to stream,
   * generates terrain within `budgetMs`, and evicts stale chunks.
   */
  update(view: Rect, budgetMs = 3) {
    this.frame++;
    const cx0 = Math.floor((view.x - 32) / CHUNK_PX_W), cx1 = Math.floor((view.x + view.w + 16) / CHUNK_PX_W);
    const cy0 = Math.floor((view.y - 40) / CHUNK_PX_H), cy1 = Math.floor((view.y + view.h + 48) / CHUNK_PX_H);
    this.detail = (cx1 - cx0 + 3) * (cy1 - cy0 + 3) <= MAX_DETAIL_CHUNKS;

    const want: number[] = [];
    if (this.detail) {
      // Prefetch one ring beyond the screen so panning rarely shows a gap.
      for (let cy = cy0 - 1; cy <= cy1 + 1; cy++)
        for (let cx = cx0 - 1; cx <= cx1 + 1; cx++) {
          if (!this.chunkInBounds(cx, cy)) continue;
          const c = this.ensure(cx, cy);
          c.lastUsed = this.frame;
          if (!this.subscribed.has(c.key)) want.push(c.key);
        }
    }
    if (want.length) {
      want.forEach((k) => this.subscribed.add(k));
      this.source.subscribe(want);
    }

    // Hysteresis: only drop subscriptions two rings out, so jiggling the camera
    // across a chunk border doesn't churn subscribe/unsubscribe.
    const drop: number[] = [];
    for (const k of this.subscribed) {
      const c = this.chunks.get(k)!;
      const inside = this.detail && c.cx >= cx0 - 2 && c.cx <= cx1 + 2 && c.cy >= cy0 - 2 && c.cy <= cy1 + 2;
      if (!inside) drop.push(k);
    }
    if (drop.length) {
      drop.forEach((k) => {
        this.subscribed.delete(k);
        // Keep terrain and last-known state for the cache, but it's no longer live.
        this.chunks.get(k)!.rev = -1;
      });
      this.source.unsubscribe(drop);
    }

    this.generate((cx0 + cx1) / 2, (cy0 + cy1) / 2, budgetMs);
    this.evict();
    this.updateStats();
  }

  private chunkInBounds(cx: number, cy: number) {
    const R = this.params.radiusPx;
    const x0 = cx * CHUNK_PX_W, y0 = cy * CHUNK_PX_H;
    const nx = Math.max(x0, Math.min(0, x0 + CHUNK_PX_W + 16)), ny = Math.max(y0, Math.min(0, y0 + CHUNK_PX_H + 7));
    return nx * nx + ny * ny < R * R;
  }

  private ensure(cx: number, cy: number) {
    const key = pack(cx, cy);
    let c = this.chunks.get(key);
    if (!c) {
      c = new Chunk(cx, cy, key);
      this.chunks.set(key, c);
      this.genQueue.add(c);
    }
    return c;
  }

  private genTerrain(c: Chunk) {
    fillChunk(this.params, c.cx, c.cy, c.kind, c.variant);
    c.terrainReady = true;
    c.version++;
    this.genQueue.delete(c);
  }

  /** Nearest-first terrain generation within a frame budget (at least one chunk). */
  private generate(ccx: number, ccy: number, budgetMs: number) {
    if (!this.genQueue.size) return;
    const queue = [...this.genQueue].sort((a, b) => Math.hypot(a.cx - ccx, a.cy - ccy) - Math.hypot(b.cx - ccx, b.cy - ccy));
    const t0 = performance.now();
    for (const c of queue) {
      this.genTerrain(c);
      if (performance.now() - t0 > budgetMs) break;
    }
  }

  private evict() {
    if (this.chunks.size <= MAX_CACHED_CHUNKS) return;
    const idle = [...this.chunks.values()].filter((c) => !this.subscribed.has(c.key)).sort((a, b) => a.lastUsed - b.lastUsed);
    for (const c of idle.slice(0, this.chunks.size - MAX_CACHED_CHUNKS)) {
      for (const s of c.structures.values()) this.structures.delete(s.id);
      this.chunks.delete(c.key);
      this.genQueue.delete(c);
    }
  }

  private updateStats() {
    const s = this.stats;
    s.cached = this.chunks.size;
    s.subscribed = this.subscribed.size;
    s.genQueue = this.genQueue.size;
    s.detail = this.detail;
    let awaiting = 0;
    for (const k of this.subscribed) if (this.chunks.get(k)!.rev < 0) awaiting++;
    s.awaiting = awaiting;
  }

  isSubscribed(key: number) {
    return this.subscribed.has(key);
  }

  // ---------------------------------------------------------------- applying shard messages
  private onSnapshot(s: ChunkSnapshot) {
    const key = pack(s.cx, s.cy);
    const c = this.chunks.get(key);
    if (!c || !this.subscribed.has(key)) return; // we lost interest while it was in flight
    if (!c.terrainReady) this.genTerrain(c);
    if (s.owner) c.owner.set(s.owner);
    else c.owner.fill(-1);
    for (const st of c.structures.values()) this.structures.delete(st.id);
    c.structures.clear();
    for (const [i, k] of s.terrain) c.kind[i] = k;
    for (const st of s.structures) this.addStructure(c, st);
    c.rev = s.rev;
    this.stats.snapshots++;
    this.touch(c, true);
  }

  private onDelta(d: ChunkDelta) {
    const key = pack(d.cx, d.cy);
    const c = this.chunks.get(key);
    if (!c || !this.subscribed.has(key) || c.rev < 0) return; // snapshot pending: it will be newer
    if (d.rev <= c.rev) return; // duplicate or stale
    if (d.rev !== c.rev + 1) return this.resync(c);
    if (d.owners) for (const [i, f] of d.owners) c.owner[i] = f;
    if (d.terrain) for (const [i, k] of d.terrain) c.kind[i] = k;
    if (d.destroyed)
      for (const i of d.destroyed) {
        const old = c.structures.get(i);
        if (old) this.listeners.destroyed?.(old);
      }
    if (d.removes)
      for (const i of d.removes) {
        const old = c.structures.get(i);
        if (old) this.structures.delete(old.id);
        c.structures.delete(i);
      }
    if (d.upserts) for (const st of d.upserts) this.addStructure(c, st);
    c.rev = d.rev;
    this.stats.deltas++;
    this.touch(c, !!d.owners);
  }

  /** We missed a revision: throw away live state and ask for a fresh snapshot. */
  private resync(c: Chunk) {
    this.stats.resyncs++;
    c.rev = -1;
    this.source.unsubscribe([c.key]);
    this.source.subscribe([c.key]);
  }

  private addStructure(c: Chunk, s: Structure) {
    const i = localIndex(s.col, s.row);
    const old = c.structures.get(i);
    if (old && old.id !== s.id) this.structures.delete(old.id);
    c.structures.set(i, s);
    this.structures.set(s.id, s);
  }

  /** Mark a chunk changed; ownership changes also dirty neighbours (shared borders). */
  private touch(c: Chunk, borders: boolean) {
    c.version++;
    if (!borders) return;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = this.chunks.get(pack(c.cx + dx, c.cy + dy));
      if (n) n.version++;
    }
  }
}
