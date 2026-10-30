// The fleet on the shard: ships stationed at Hangars, boarding and refitting
// only while docked, fits validated from scratch, and the Hangar's item bay.
import { describe, expect, it } from 'vitest';
import { PLAYER } from '../defs';
import { tileX, tileY } from '../hex';
import { emptyFit, withModule } from '../ships/fitting';
import { DOCK_RANGE } from '../ships/fleet';
import { LocalShard } from '../sim/LocalShard';
import { tileCenterX, tileCenterY } from '../terrain';
import { WorldView } from '../WorldView';

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
  const hangar = [...view.structures.values()].find((s) => s.kind === 'hangar' && s.owner === PLAYER)!;
  const docked = { x: tileCenterX(hangar.col, hangar.row), y: tileCenterY(hangar.row) + 30 };
  const away = { x: docked.x + DOCK_RANGE * 4, y: docked.y };
  return { view, advance, hangar, docked, away };
}

describe('fleet', () => {
  it('starts with one ship flying and the rest stationed at a starter Hangar', async () => {
    const { view, hangar } = await setup();
    const f = view.fleet!;
    expect(f.ships.length).toBe(4);
    expect(f.ships.find((s) => s.id === f.flying)!.station).toBeNull();
    expect(f.ships.filter((s) => s.id !== f.flying).every((s) => s.station === hangar.id)).toBe(true);
  });

  it('boards a stationed ship only while docked, leaving the old one in the Hangar', async () => {
    const { view, advance, hangar, docked, away } = await setup();
    const before = view.fleet!.flying, wisp = view.fleet!.ships.find((s) => s.hull === 'wisp')!;
    expect((await view.board(wisp.id, away)).ok).toBe(false);
    expect((await view.board(wisp.id, docked)).ok).toBe(true);
    advance(0.2);
    expect(view.fleet!.flying).toBe(wisp.id);
    expect(view.fleet!.ships.find((s) => s.id === before)!.station).toBe(hangar.id);
  });

  it('refits only while docked, and rejects fits that break the rules', async () => {
    const { view, advance, docked, away } = await setup();
    const me = view.fleet!.ships.find((s) => s.id === view.fleet!.flying)!;
    const lighter = withModule(emptyFit(me.hull), 'high', 0, 'pulse-laser');
    expect((await view.refit(me.id, lighter, away)).ok).toBe(false);
    expect((await view.refit(me.id, withModule(lighter, 'mid', 0, 'pulse-laser'), docked)).ok).toBe(false); // weapon in a mid slot
    const greedy = { ...lighter, high: lighter.high.map(() => 'siege-lance') }; // far over power
    expect((await view.refit(me.id, greedy, docked)).ok).toBe(false);
    expect((await view.refit(me.id, lighter, docked)).ok).toBe(true);
    advance(0.2);
    expect(view.fleet!.ships.find((s) => s.id === me.id)!.fit).toEqual(lighter);
  });

  it('moves items into the Hangar bay while docked', async () => {
    const { view, advance, hangar, docked } = await setup();
    // Grab loot from a cache near home first.
    const home = view.meta!.homes[PLAYER];
    let cache: [number, number] | null = null;
    for (let r = home.row - 8; r <= home.row + 8 && !cache; r++)
      for (let c = home.col - 8; c <= home.col + 8 && !cache; c++) if (view.kind(c, r) === 'cache') cache = [c, r];
    await view.openCache(...cache!, { x: tileCenterX(...cache!), y: tileCenterY(cache![1]) });
    advance(0.2);
    const me = view.fleet!.flying, item = view.cargo!.holds[me][0];
    const r = await view.cargoOp({ op: 'move', from: { ship: me }, uid: item.uid, to: { store: hangar.id }, x: 0, y: 0, rot: false }, docked);
    expect(r.ok).toBe(true);
    advance(0.2);
    expect(view.cargo!.stores[hangar.id].map((i) => i.uid)).toEqual([item.uid]);
  });
});
