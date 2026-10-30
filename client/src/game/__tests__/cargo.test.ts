// Cargo rules (pure) and the shard's cache and Storage handling.
import { describe, expect, it } from 'vitest';
import { PLAYER, STRUCT } from '../defs';
import { hexesInRadius, tileX, tileY } from '../hex';
import { addItem, CACHE_RESPAWN, canPlace, cargoGrid, CargoItem, STORAGE_RANGE, usedCells } from '../ships/cargo';
import { computeStats } from '../ships/fitting';
import { starterFit } from '../ships/hangar';
import { HULLS } from '../ships/hulls';
import { LocalShard } from '../sim/LocalShard';
import { tileCenterX, tileCenterY } from '../terrain';
import { WorldView } from '../WorldView';

describe('cargo grid', () => {
  it('grows with the cargo stat, and every hull gets a usable hold', () => {
    const cells = HULLS.map((h) => {
      const g = cargoGrid(computeStats(h.id, starterFit(h.id)).cargo);
      return g.w * g.h;
    });
    expect(Math.min(...cells)).toBeGreaterThanOrEqual(16);
    expect(cargoGrid(400).h).toBeGreaterThan(cargoGrid(100).h);
  });

  it('packs items without overlap until full', () => {
    const g = { w: 4, h: 2 };
    let items: CargoItem[] = [];
    for (let uid = 1; uid <= 2; uid++) items = addItem(items, g, 'ore', uid)!;
    expect(usedCells(items, g)).toBe(8);
    expect(addItem(items, g, 'shard', 3)).toBeNull();
    expect(canPlace(items, g, { uid: 9, kind: 'shard', x: 1, y: 1, rot: false })).toBe(false);
  });

  it('ignores overflow items (outside a shrunken grid) when placing', () => {
    const g = { w: 2, h: 2 };
    const overflow: CargoItem = { uid: 1, kind: 'relic', x: 0, y: 0, rot: false }; // 3 wide: can't be in a 2x2
    expect(canPlace([overflow], g, { uid: 2, kind: 'ore', x: 0, y: 0, rot: false })).toBe(true);
  });
});

async function setup() {
  let t = 0;
  const shard = new LocalShard({ seed: 7, radiusPx: 6000, latencyMs: 0, manual: true, clock: () => t });
  const view = new WorldView(shard);
  const advance = (seconds: number) => {
    for (let i = 0; i < seconds * 10; i++) {
      t += 0.1;
      shard.step(0.1);
    }
  };
  await view.connect();
  const home = view.meta!.homes[PLAYER];
  view.update({ x: tileX(home.col, home.row) - 1500, y: tileY(home.row) - 900, w: 3000, h: 1800 }, 1000);
  advance(0.2);
  const ship = (col: number, row: number) => ({ x: tileCenterX(col, row), y: tileCenterY(row) + 20, hull: 'lancer' as const, fit: starterFit('lancer') });
  return { shard, view, advance, home, ship };
}

describe('caches', () => {
  it('opens once into the hold, then restocks', async () => {
    const { view, advance, home, ship } = await setup();
    const spot = hexesInRadius(home.col, home.row, 7).find(([c, r]) => view.kind(c, r) === 'cache')!;
    expect(spot).toBeDefined();

    const far = await view.openCache(...spot, { ...ship(...spot), x: ship(...spot).x + 400 });
    expect(far.ok).toBe(false);

    const r = await view.openCache(...spot, ship(...spot));
    expect(r.ok).toBe(true);
    expect(r.loot!.length).toBeGreaterThanOrEqual(2);
    advance(0.2);
    expect(view.cargo!.holds[view.fleet!.flying].length).toBe(r.loot!.length);
    expect(view.kind(...spot)).toBe('cacheOpen');
    expect((await view.openCache(...spot, ship(...spot))).ok).toBe(false);

    advance(CACHE_RESPAWN + 1);
    expect(view.kind(...spot)).toBe('cache');
  });
});

describe('storage', () => {
  it('takes items from a ship in range, refuses one out of range, and loses them when destroyed', async () => {
    const { view, advance, home, ship } = await setup();
    // Loot something to move.
    const cache = hexesInRadius(home.col, home.row, 7).find(([c, r]) => view.kind(c, r) === 'cache')!;
    await view.openCache(...cache, ship(...cache));
    // Build a Storage Bay next to the Nexus.
    const spot = hexesInRadius(home.col, home.row, 2).find(([c, r]) => view.canBuild('storage', c, r).ok)!;
    await view.build('storage', ...spot);
    advance(STRUCT.storage.buildTime + 1);
    const store = view.structure(...spot)!;
    const me = view.fleet!.flying, near = ship(...spot), item = view.cargo!.holds[me][0];
    const op = { op: 'move' as const, from: { ship: me }, uid: item.uid, to: { store: store.id }, x: 0, y: 0, rot: false };

    const refused = await view.cargoOp(op, { ...near, x: near.x + STORAGE_RANGE * 3 });
    expect(refused.ok).toBe(false);
    expect((await view.cargoOp(op, near)).ok).toBe(true);
    advance(0.2);
    expect(view.cargo!.stores[store.id].map((i) => i.uid)).toEqual([item.uid]);
    expect(view.cargo!.holds[me].some((i) => i.uid === item.uid)).toBe(false);

    // Destroyed with it.
    await view.fire({ ...near, target: store.id });
    advance(STRUCT.storage.hp / 20 + 5);
    expect(view.structure(...spot)).toBeNull();
    expect(view.cargo!.stores[store.id]).toBeUndefined();
  });
});
