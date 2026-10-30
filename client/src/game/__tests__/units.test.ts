// Ground troops: routes as functions of time, squads marching on and
// destroying a target, and Pulse Batteries cutting them down.
import { describe, expect, it } from 'vitest';
import { PLAYER, STRUCT, StructureKind } from '../defs';
import { hexDist, hexesInRadius, tileX, tileY } from '../hex';
import { hpOf, Squad, Structure } from '../protocol';
import { LocalShard } from '../sim/LocalShard';
import { VOID } from '../terrain';
import { aliveOf, findPath, SQUAD_COST, squadAt, TROOPER_HP } from '../units';
import { WorldView } from '../WorldView';

describe('routes', () => {
  const q = (route: number[]): Squad => ({ id: 1, owner: 0, target: 2, route, startAt: 10, speed: 10, size: 3, attackers: [], hp: 3 * TROOPER_HP, hpAt: 10, drain: 0 });

  it('walks the route at its speed and stops at the end', () => {
    const s = q([0, 0, 100, 0, 100, 50]);
    expect(squadAt(s, 15)).toMatchObject({ x: 50, y: 0, arrived: false });
    expect(squadAt(s, 22)).toMatchObject({ x: 100, y: 20, arrived: false });
    expect(squadAt(s, 99)).toMatchObject({ x: 100, y: 50, arrived: true });
  });

  it('loses troopers one by one as the pool drains', () => {
    const s = { ...q([0, 0, 1, 0]), drain: TROOPER_HP };
    expect(aliveOf(s, 10)).toBe(3);
    expect(aliveOf(s, 10.5)).toBe(3);
    expect(aliveOf(s, 11.5)).toBe(2);
    expect(aliveOf(s, 13)).toBe(0);
  });

  it('finds a way round the void, and none across it', () => {
    // A wall of void at col 5 with a gap at row 9.
    const land = { kindId: (c: number, r: number) => (c === 5 && r !== 9) || c < 0 || c > 10 || r < 0 || r > 10 ? VOID : 1, structure: () => null };
    const path = findPath(land, [2, 2], [8, 2])!;
    expect(path.some(([c, r]) => c === 5 && r === 9)).toBe(true);
    expect(hexDist(...path[path.length - 1], 8, 2)).toBeLessThanOrEqual(1);
    const walled = { ...land, kindId: (c: number, r: number) => (c === 5 ? VOID : land.kindId(c, r)) };
    expect(findPath(walled, [2, 2], [8, 2])).toBeNull();
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
  const internal = shard as unknown as { place(k: StructureKind, c: number, r: number, f: number, instant: boolean): void; structure(c: number, r: number): Structure };
  // Free land near home, away from the Nexus.
  const free = hexesInRadius(home.col, home.row, 9).filter(([c, r]) => shard.kindId(c, r) !== VOID && !shard.structure(c, r) && hexDist(c, r, home.col, home.row) >= 3);
  const bayAt = free.find(([c, r]) => view.canBuild('mechbay', c, r).ok)!;
  await view.build('mechbay', ...bayAt);
  advance(STRUCT.mechbay.buildTime + 1);
  const bay = view.structure(...bayAt)!;
  // An enemy building a short march away, placed directly on the shard.
  const spot = free.find(([c, r]) => hexDist(c, r, ...bayAt) >= 5 && !shard.structure(c, r))!;
  internal.place('solar', ...spot, 1, true);
  shard.flush();
  const target = internal.structure(...spot);
  return { shard, view, advance, internal, free, bay, target, spot };
}

describe('squads', () => {
  it('deploys only from a finished Mech Bay at an enemy, charging the cost and cooling down', async () => {
    const { view, bay, target, advance } = await setup();
    const nexus = [...view.structures.values()].find((s) => s.kind === 'nexus' && s.owner === PLAYER)!;
    expect((await view.deploy(bay.id, nexus.id)).ok).toBe(false);
    const credits = view.player.res.credits;
    expect((await view.deploy(bay.id, target.id)).ok).toBe(true);
    advance(0.2);
    expect(view.player.res.credits).toBeLessThanOrEqual(credits - SQUAD_COST.credits + 20);
    expect(view.squads.size).toBe(1);
    expect((await view.deploy(bay.id, target.id)).ok).toBe(false); // still training the next
  });

  it('marches on the target and destroys it', async () => {
    const { view, advance, bay, target, spot } = await setup();
    await view.deploy(bay.id, target.id);
    advance(0.2);
    const q = [...view.squads.values()][0];
    expect(q.target).toBe(target.id);
    advance(60);
    expect(view.structure(...spot)).toBeNull();
  });

  it('is cut down by a Pulse Battery guarding the target', async () => {
    const { view, advance, bay, target, spot, internal, shard, free } = await setup();
    const guard = free.find(([c, r]) => hexDist(c, r, ...spot) === 1 && !shard.structure(c, r))!;
    internal.place('turret', ...guard, 1, true);
    shard.flush();
    await view.deploy(bay.id, target.id);
    advance(0.2);
    const id = [...view.squads.keys()][0];
    let shot = false;
    for (let i = 0; i < 600 && view.squads.has(id); i++) {
      advance(0.1);
      shot ||= (view.squads.get(id)?.attackers.length ?? 0) > 0;
    }
    expect(shot).toBe(true);
    expect(view.squads.has(id)).toBe(false);
    const left = view.structure(...spot);
    expect(left).not.toBeNull();
    expect(hpOf(left!, view.now())).toBeGreaterThan(0);
  });

  it('can be strafed by the flagship', async () => {
    const { view, advance, bay, target } = await setup();
    await view.deploy(bay.id, target.id);
    advance(0.2);
    const q = [...view.squads.values()][0], at = squadAt(q, view.now());
    expect((await view.fire({ target: q.id, unit: true, x: at.x, y: at.y })).ok).toBe(true);
    advance(0.2);
    expect(view.squads.get(q.id)!.drain).toBeGreaterThan(0);
  });
});
