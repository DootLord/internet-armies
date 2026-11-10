// In-process WorldSource: a whole Sector running inside the page (offline play,
// ?offline) or inside a test. It plays the part the gateway and network play in
// production: one player, simulated latency, and chunk interest filtering.
import type { StructureKind } from '../defs';
import { dispatch } from '../protocol';
import type { BuildCheck, CacheResult, CargoOp, EmpireInfo, FireOrder, Push, ShipReport, SourceHandlers, WorldMeta, WorldSource } from '../protocol';
import type { Fit } from '../ships/fitting';
import { Sector } from './Sector';

export interface ShardOptions {
  seed: number;
  radiusPx: number;
  /** Simulated one-way network latency. 0 delivers synchronously (tests). */
  latencyMs?: number;
  /** Tests drive time themselves via step(); otherwise a 10 Hz timer runs. */
  manual?: boolean;
  clock?: () => number;
  /** Other empires founded alongside yours, so there is something to fight. */
  rivals?: number;
}

/** The local player's empire id. */
export const LOCAL_PLAYER = 1;

export class LocalShard implements WorldSource {
  readonly sector: Sector;
  /** Rival empire ids (tests aim at these). */
  readonly rivals: number[] = [];
  private subs = new Set<number>();
  private h: SourceHandlers | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private latency: number;

  constructor(o: ShardOptions) {
    const clock = o.clock ?? (() => performance.now() / 1000);
    const t0 = clock();
    this.latency = o.latencyMs ?? 60;
    const send = (m: Push) => this.send(m);
    this.sector = new Sector({
      seed: o.seed,
      radiusPx: o.radiusPx,
      clock: () => clock() - t0,
      sink: {
        player: (e, m) => { if (e === LOCAL_PLAYER) send(m); },
        chunk: (ck, m) => { if (this.subs.has(ck)) send(m); },
        all: send,
      },
    });
    for (let i = 0; i < (o.rivals ?? 0); i++) {
      const info: EmpireInfo = { id: LOCAL_PLAYER + 1 + i, name: RIVALS[i % RIVALS.length], color: 1 + (i % 9) };
      this.sector.join(info);
      this.sector.leave(info.id);
      this.rivals.push(info.id);
    }
    if (!o.manual) {
      let last = clock();
      this.timer = setInterval(() => {
        const t = clock();
        this.step(t - last);
        last = t;
      }, 100);
    }
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
  }

  now() {
    return this.sector.now();
  }

  step(dt: number) {
    this.sector.step(dt);
  }

  /** Deliver to the client after the simulated latency. Constant delay keeps FIFO order. */
  private send(m: Push) {
    const h = this.h;
    if (!h) return;
    if (this.latency <= 0) dispatch(h, m);
    else setTimeout(() => dispatch(h, m), this.latency);
  }

  private reply<T>(v: T): Promise<T> {
    return new Promise((res) => (this.latency <= 0 ? res(v) : setTimeout(() => res(v), this.latency)));
  }

  // ---------------------------------------------------------------- WorldSource
  connect(h: SourceHandlers): Promise<WorldMeta> {
    this.h = h;
    return this.reply(this.sector.join({ id: LOCAL_PLAYER, name: 'DootLord Inc', color: 0 }));
  }

  subscribe(keys: number[]) {
    for (const k of keys) this.subs.add(k);
    this.send({ t: 'chunks', list: this.sector.snapshots(keys) });
  }

  unsubscribe(keys: number[]) {
    for (const k of keys) this.subs.delete(k);
  }

  build(kind: StructureKind, col: number, row: number): Promise<BuildCheck> {
    return this.reply(this.sector.build(LOCAL_PLAYER, kind, col, row));
  }
  demolish(col: number, row: number): Promise<BuildCheck> {
    return this.reply(this.sector.demolish(LOCAL_PLAYER, col, row));
  }
  fire(order: FireOrder | null): Promise<BuildCheck> {
    return this.reply(this.sector.fire(LOCAL_PLAYER, order));
  }
  deploy(bay: number, target: number): Promise<BuildCheck> {
    return this.reply(this.sector.deploy(LOCAL_PLAYER, bay, target));
  }
  cargo(op: CargoOp, ship: ShipReport): Promise<BuildCheck> {
    return this.reply(this.sector.cargo(LOCAL_PLAYER, op, ship));
  }
  openCache(col: number, row: number, ship: ShipReport): Promise<CacheResult> {
    return this.reply(this.sector.openCache(LOCAL_PLAYER, col, row, ship));
  }
  board(shipId: number, ship: ShipReport): Promise<BuildCheck> {
    return this.reply(this.sector.board(LOCAL_PLAYER, shipId, ship));
  }
  refit(shipId: number, fit: Fit, ship: ShipReport): Promise<BuildCheck> {
    return this.reply(this.sector.refit(LOCAL_PLAYER, shipId, fit, ship));
  }
  report(ship: ShipReport) {
    this.sector.report(LOCAL_PLAYER, ship);
  }

  // ---------------------------------------------------------------- reads for tests and tooling
  kindId(col: number, row: number) {
    return this.sector.kindId(col, row);
  }
  owner(col: number, row: number) {
    return this.sector.owner(col, row);
  }
  structure(col: number, row: number) {
    return this.sector.structure(col, row);
  }
  flush() {
    this.sector.flush();
  }
}

const RIVALS = ['Vanguard Syndicate', 'Crimson Accord', 'Verdant Collective', 'Umbral Reach', 'Solace Union'];
