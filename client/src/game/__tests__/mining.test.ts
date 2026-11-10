// The mining dig: same seed same slab, cutting stone frees finds, and the beam
// burns finds it touches once they're exposed.
import { describe, expect, it } from 'vitest';
import { COLS, Dig, Find, FREE_AT, MAX_CHARGE, ROWS, TOOLS } from '../mining/excavation';

const [cutter, precision] = TOOLS;
/** Fire at a cell until its stack is gone (cooling whenever the laser overheats). */
function clear(d: Dig, x: number, y: number, tool = precision) {
  for (let i = 0; i < 2000 && d.layers(x, y); i++) {
    if (!d.canFire) {
      d.cool(0.1);
      continue;
    }
    d.fire(tool, x + 0.5, y + 0.5, 0.02);
  }
}

describe('dig', () => {
  it('is the same slab for the same seed, with every find under stone', () => {
    const a = new Dig(42, 'crystal'), b = new Dig(42, 'crystal');
    expect(a.finds.map((f) => [f.kind, f.x, f.y])).toEqual(b.finds.map((f) => [f.kind, f.x, f.y]));
    expect(a.finds.length).toBeGreaterThanOrEqual(4);
    for (const f of a.finds) {
      expect(f.x + f.w).toBeLessThanOrEqual(COLS);
      expect(f.y + f.h).toBeLessThanOrEqual(ROWS);
      expect(a.exposure(f)).toBe(0);
    }
  });

  it('frees a find once most of it is uncovered, and the Precision beam never harms it', () => {
    const d = new Dig(7, 'ore');
    d.charge = Infinity;
    const f = d.finds[0];
    for (let j = f.y; j < f.y + f.h && f.state === 'buried'; j++) for (let i = f.x; i < f.x + f.w && f.state === 'buried'; i++) clear(d, i, j);
    expect(f.state).toBe('recovered');
    expect(f.integrity).toBe(1);
    expect(d.exposure(f)).toBeGreaterThanOrEqual(FREE_AT);
    expect(d.exposure(f)).toBeLessThan(1);
    expect(d.haul).toContain(f.kind);
  });

  it('burns an exposed find under the beam until it is lost', () => {
    const d = new Dig(9, 'ore');
    d.charge = Infinity;
    const f = d.finds[0] as Find;
    clear(d, f.x, f.y); // one corner open
    for (let i = 0; i < 400 && f.state === 'buried'; i++) {
      d.heat = 0;
      d.overheated = false;
      d.fire(cutter, f.x + 0.5, f.y + 0.5, 0.02);
    }
    expect(f.state).toBe('lost');
  });

  it('overheats, locks until it cools, and runs out of charge', () => {
    const d = new Dig(3, 'ruin');
    for (let i = 0; i < 200 && !d.overheated; i++) d.fire(cutter, 10, 8, 0.05);
    expect(d.overheated).toBe(true);
    expect(d.canFire).toBe(false);
    for (let i = 0; i < 100 && d.overheated; i++) d.cool(0.1);
    expect(d.canFire).toBe(true);
    expect(d.charge).toBeLessThan(MAX_CHARGE);
    d.charge = 0;
    expect(d.done).toBe(true);
  });
});
