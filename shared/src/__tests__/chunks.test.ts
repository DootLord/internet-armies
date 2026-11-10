import { describe, expect, it } from 'vitest';
import { chunkKeyOf, chunkOf, CS, localIndex, pack, unpackA, unpackB } from '../chunks';
import { fillChunk, terrainKind } from '../terrain';

describe('chunk coordinates', () => {
  it('floors negative coordinates into the right chunk', () => {
    expect(chunkOf(0)).toBe(0);
    expect(chunkOf(31)).toBe(0);
    expect(chunkOf(32)).toBe(1);
    expect(chunkOf(-1)).toBe(-1);
    expect(chunkOf(-32)).toBe(-1);
    expect(chunkOf(-33)).toBe(-2);
  });

  it('maps every tile of a negative chunk to a unique local index', () => {
    const seen = new Set<number>();
    for (let row = -32; row < 0; row++) for (let col = -64; col < -32; col++) seen.add(localIndex(col, row));
    expect(seen.size).toBe(CS * CS);
    expect(Math.min(...seen)).toBe(0);
    expect(Math.max(...seen)).toBe(CS * CS - 1);
  });

  it('round-trips packed keys, including negatives', () => {
    for (const [a, b] of [[0, 0], [-1, 5], [1234, -4321], [-32000, 32000]]) {
      const k = pack(a, b);
      expect([unpackA(k), unpackB(k)]).toEqual([a, b]);
    }
    expect(chunkKeyOf(-1, -1)).toBe(pack(-1, -1));
  });
});

describe('terrain', () => {
  const p = { seed: 42, radiusPx: 8000 };

  it('is deterministic', () => {
    for (let i = 0; i < 200; i++) {
      const col = (i * 37) % 300 - 150, row = (i * 53) % 300 - 150;
      expect(terrainKind(p, col, row)).toBe(terrainKind({ ...p }, col, row));
    }
  });

  it('fills chunks consistently with per-tile generation (incl. negative chunks)', () => {
    for (const [cx, cy] of [[0, 0], [-1, -1], [2, -3]]) {
      const kind = new Uint8Array(CS * CS);
      fillChunk(p, cx, cy, kind);
      for (let lr = 0; lr < CS; lr += 7)
        for (let lc = 0; lc < CS; lc += 5) {
          const col = cx * CS + lc, row = cy * CS + lr;
          expect(kind[localIndex(col, row)]).toBe(terrainKind(p, col, row));
        }
    }
  });

  it('is void outside the world radius', () => {
    expect(terrainKind(p, 10000, 0)).toBe(0);
  });
});
