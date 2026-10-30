// Fire orders through the shard: damage is derived from timestamps, never
// ticked, and a destroyed structure reaches watching clients as an explosion.
import { describe, expect, it } from 'vitest';
import { PLAYER, STRUCT } from '../defs';
import { tileCenterX, tileCenterY } from '../terrain';
import { tileX, tileY } from '../hex';
import { hpOf, Structure } from '../protocol';
import { weaponStats } from '../ships/fitting';
import { starterFit } from '../ships/hangar';
import { LocalShard } from '../sim/LocalShard';
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
  // A finished Solar Array next to the Nexus to shoot at.
  let spot: [number, number] | null = null;
  for (let dr = -2; dr <= 2 && !spot; dr++)
    for (let dc = -2; dc <= 2 && !spot; dc++) if (view.canBuild('solar', home.col + dc, home.row + dr).ok) spot = [home.col + dc, home.row + dr];
  await view.build('solar', ...spot!);
  advance(STRUCT.solar.buildTime + 1);
  const target = view.structure(...spot!)!;
  const fit = starterFit('lancer');
  const near = { x: tileCenterX(...spot!), y: tileCenterY(spot![1]) + 40, hull: 'lancer' as const, fit };
  return { shard, view, advance, target, near, now: () => shard.now() };
}

describe('combat', () => {
  it('drains health at the fit’s pulse laser DPS and destroys the target', async () => {
    const { view, advance, target, near, now } = await setup();
    const dps = weaponStats('lancer', near.fit, 'pulse-laser').dps;
    const lost: Structure[] = [];
    view.listeners.destroyed = (s) => lost.push(s);

    expect((await view.fire({ ...near, target: target.id })).ok).toBe(true);
    advance(0.2);
    const live = view.structure(target.col, target.row)!;
    expect(live.drain).toBeCloseTo(dps);
    expect(hpOf(live, now())).toBeLessThan(STRUCT.solar.hp);

    advance(STRUCT.solar.hp / dps + 1);
    expect(view.structure(target.col, target.row)).toBeNull();
    expect(lost.map((s) => s.id)).toEqual([target.id]);
  });

  it('settles health when firing stops, and refuses targets out of range', async () => {
    const { view, advance, target, near, now } = await setup();
    await view.fire({ ...near, target: target.id });
    advance(3);
    await view.fire(null);
    advance(0.2);
    const s = view.structure(target.col, target.row)!;
    expect(s.drain).toBe(0);
    const hp = hpOf(s, now());
    advance(5);
    expect(hpOf(view.structure(target.col, target.row)!, now())).toBe(hp);

    const far = await view.fire({ ...near, x: near.x + 5000, target: target.id });
    expect(far).toEqual({ ok: false, reason: 'Out of range' });
  });
});
