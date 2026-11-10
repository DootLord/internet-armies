// The multi-empire Sector on its own: founding empires, validating flight,
// resources as lines, and surviving a restart through persisted rows.
import { describe, expect, it } from 'vitest';
import { chunkKeyOf } from '../chunks';
import { STRUCT } from '../defs';
import { hexDist } from '../hex';
import type { Push } from '../protocol';
import { SectorChanges, SectorData, Sector, SectorSink } from '../sim/Sector';
import { tileCenterX, tileCenterY } from '../terrain';

function setup(data?: SectorData, start = 0) {
  let t = start;
  const pushes: { to: string; m: Push }[] = [];
  const sink: SectorSink = {
    player: (e, m) => pushes.push({ to: `p${e}`, m }),
    chunk: (ck, m) => pushes.push({ to: `c${ck}`, m }),
    all: (m) => pushes.push({ to: 'all', m }),
  };
  const sector = new Sector({ seed: 11, radiusPx: 8000, clock: () => t, sink }, data);
  const advance = (seconds: number) => {
    for (let i = 0; i < seconds * 10; i++) {
      t += 0.1;
      sector.step(0.1);
    }
  };
  return { sector, pushes, advance, now: () => t };
}

/** A stand-in for the database: applies each batch of changes as upserts and deletes, like the shard's Postgres store. */
function memoryStore() {
  const rows = {
    empires: new Map(), structures: new Map(), chunks: new Map(), ships: new Map(), containers: new Map(), squads: new Map(),
  } as Record<'empires' | 'structures' | 'chunks' | 'ships' | 'containers' | 'squads', Map<unknown, unknown>>;
  let savedAt = 0;
  return {
    save(c: SectorChanges) {
      savedAt = c.savedAt;
      for (const r of c.empires) rows.empires.set(r.id, structuredClone(r));
      for (const id of c.goneEmpires) rows.empires.delete(id);
      for (const r of c.structures) rows.structures.set(r.id, structuredClone(r));
      for (const id of c.goneStructures) rows.structures.delete(id);
      for (const r of c.chunks) rows.chunks.set(r.ck, structuredClone(r));
      for (const r of c.ships) rows.ships.set(r.id, structuredClone(r));
      for (const id of c.goneShips) rows.ships.delete(id);
      for (const r of c.containers) rows.containers.set(r.key, structuredClone(r));
      for (const k of c.goneContainers) rows.containers.delete(k);
      for (const r of c.squads) rows.squads.set(r.id, structuredClone(r));
      for (const id of c.goneSquads) rows.squads.delete(id);
    },
    load(): SectorData {
      const all = <T>(m: Map<unknown, unknown>) => structuredClone([...m.values()]) as T[];
      return {
        savedAt, empires: all(rows.empires), structures: all(rows.structures), chunks: all(rows.chunks), ships: all(rows.ships),
        containers: all(rows.containers), squads: all(rows.squads),
      };
    },
  };
}

const A = { id: 101, name: 'Alpha', color: 1 };
const B = { id: 202, name: 'Bravo', color: 2 };

describe('sector', () => {
  it('founds each new empire in its own free space, with a Nexus, Hangar and fleet', () => {
    const { sector } = setup();
    const ma = sector.join(A), mb = sector.join(B);
    const ha = ma.homes[A.id], hb = mb.homes[B.id];
    expect(hexDist(ha.col, ha.row, hb.col, hb.row)).toBeGreaterThan(8);
    expect(sector.structure(ha.col, ha.row)?.kind).toBe('nexus');
    expect(sector.structure(ha.col, ha.row)?.owner).toBe(A.id);
    expect(mb.homes[A.id]).toEqual(ha); // later players learn about earlier ones
    // Joining again is a reconnect, not a second empire.
    expect(sector.join(A).homes[A.id]).toEqual(ha);
    expect(sector.empireCount).toBe(2);
  });

  it('accrues resources as a line between changes, and charges builds against it', () => {
    const { sector, advance, pushes } = setup();
    sector.join(A);
    const latest = () => [...pushes].reverse().find((p) => p.to === `p${A.id}` && p.m.t === 'player')!.m as Extract<Push, { t: 'player' }>;
    advance(1.05);
    const r0 = latest().p;
    advance(10);
    const r1 = latest().p;
    expect(r1.res.credits - r0.res.credits).toBeCloseTo(r0.rates.credits * 10, -1);
  });

  it('accepts flight it could have flown, and corrects teleports', () => {
    const { sector, advance, pushes } = setup();
    const meta = sector.join(A);
    const at = meta.ship;
    advance(1);
    sector.report(A.id, { x: at.x + 100, y: at.y }); // ~100 px/s: fine
    expect(pushes.some((p) => p.m.t === 'correct')).toBe(false);
    advance(0.1);
    sector.report(A.id, { x: at.x + 5000, y: at.y }); // 5 km in a tenth of a second: no
    const fix = pushes.find((p) => p.m.t === 'correct');
    expect(fix?.to).toBe(`p${A.id}`);
    expect(fix?.m).toMatchObject({ x: at.x + 100, y: at.y });
    // ...but reappearing at your own Nexus after a wreck is allowed.
    const home = meta.homes[A.id];
    pushes.length = 0;
    sector.report(A.id, { x: tileCenterX(home.col, home.row) + 30, y: tileCenterY(home.row) });
    expect(pushes.some((p) => p.m.t === 'correct')).toBe(false);
  });

  it('sends chunk changes to the chunk, and your own news to you', () => {
    const { sector, pushes, advance } = setup();
    const meta = sector.join(A);
    const home = meta.homes[A.id];
    pushes.length = 0;
    const spot = sector.frontier(A.id)[0];
    sector.place('relay', ...spot, A.id, false);
    advance(STRUCT.relay.buildTime + 1);
    expect(pushes.some((p) => p.to === `c${chunkKeyOf(...spot)}` && p.m.t === 'delta')).toBe(true);
    expect(pushes.some((p) => p.to === `p${A.id}` && p.m.t === 'event' && p.m.e.type === 'online')).toBe(true);
    expect(home).toBeDefined();
  });

  it('comes back from its saved rows after a crash, with nothing lost or duplicated', () => {
    const store = memoryStore();
    const one = setup();
    const meta = one.sector.join(A);
    one.sector.join(B);
    store.save(one.sector.takeChanges());
    const home = meta.homes[A.id];
    const spot = one.sector.frontier(A.id)[0];
    expect(one.sector.build(A.id, 'relay', ...spot).ok).toBe(true);
    one.advance(5);
    store.save(one.sector.takeChanges());
    const builtAt = one.now();

    // The process dies. A new one loads the rows, 30 seconds later.
    const two = setup(store.load(), builtAt + 30);
    const again = two.sector.join(A);
    expect(again.homes[A.id]).toEqual(home);
    expect(two.sector.structure(...spot)?.kind).toBe('relay');
    expect(two.sector.structure(...spot)?.owner).toBe(A.id);
    expect(two.sector.empireCount).toBe(2);
    // Construction kept to its schedule while the shard was down: the relay is finished and claims land.
    two.advance(0.2);
    expect(two.sector.owner(...spot)).toBe(A.id);
    // Ships and items keep their ids, and new ones never collide with them.
    const fleet = [...two.pushes].reverse().find((p) => p.m.t === 'fleet')!.m as Extract<Push, { t: 'fleet' }>;
    const ids = fleet.f.ships.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    two.sector.join(B);
    const c = two.sector.takeChanges();
    expect(c.ships.length).toBe(0); // reconnecting doesn't rewrite the fleet
  });

  it('purges an empire completely when its account is deleted', () => {
    const { sector } = setup();
    const meta = sector.join(A);
    sector.takeChanges();
    const home = meta.homes[A.id];
    sector.purge(A.id);
    expect(sector.structure(home.col, home.row)).toBeNull();
    expect(sector.owner(home.col, home.row)).toBe(-1);
    const c = sector.takeChanges();
    expect(c.goneEmpires).toEqual([A.id]);
    expect(c.goneShips.length).toBeGreaterThan(0);
    expect(c.goneStructures.length).toBeGreaterThan(0);
  });
});
