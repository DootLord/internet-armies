import { describe, expect, it } from 'vitest';
import { shipModel } from '../ships/shapes';
import { splitModel } from '../ships/voxel';

const solid = (d: Uint8Array) => d.reduce((n, v) => n + (v ? 1 : 0), 0);

describe('wreck fracture', () => {
  it('splits a hull into chunks that together keep (almost) every voxel', () => {
    const m = shipModel('lancer');
    const pieces = splitModel(m, 6, 42);
    expect(pieces.length).toBeGreaterThanOrEqual(3);
    // Only slivers under the minimum chunk size are dropped.
    const kept = pieces.reduce((n, p) => n + solid(p.model.data), 0);
    expect(kept / solid(m.data)).toBeGreaterThan(0.97);
  });

  it('places each chunk inside the parent hull', () => {
    const m = shipModel('bastion');
    for (const p of splitModel(m, 8, 7)) {
      expect(Math.abs(p.offset[0])).toBeLessThanOrEqual(m.cx);
      expect(Math.abs(p.offset[1])).toBeLessThanOrEqual(m.cy);
      expect(Math.abs(p.offset[2])).toBeLessThanOrEqual(m.cz);
    }
  });
});
