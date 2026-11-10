// Deterministic terrain: f(seed, col, row) -> kind. Shared by client and shard,
// so the shard never ships terrain, only what players changed (overrides).
// Any change here changes the world: version it like a protocol.
import { CS } from './chunks';
import type { TileKind } from './defs';
import { fbm, hash2, smoothstep } from './rng';

// Append only: ids are part of the protocol (terrain overrides send them).
export const KINDS: TileKind[] = ['void', 'plate', 'rock', 'ore', 'crystal', 'ice', 'gas', 'ruin', 'cache', 'cacheOpen'];
export const KIND_ID = Object.fromEntries(KINDS.map((k, i) => [k, i])) as Record<TileKind, number>;
export const VOID = 0;

export interface TerrainParams {
  seed: number;
  radiusPx: number;
}

export const tileCenterX = (col: number, row: number) => col * 32 + (row & 1) * 16 + 16;
export const tileCenterY = (row: number) => row * 21 + 14;

export function terrainKind(p: TerrainParams, col: number, row: number): number {
  const { seed } = p;
  const x = tileCenterX(col, row), y = tileCenterY(row);
  const d = Math.sqrt(x * x + y * y) / p.radiusPx;
  if (d >= 1) return VOID;
  const continent = fbm(x * 0.00055, y * 0.00055, seed + 77, 3);
  const n = fbm(x * 0.0032, y * 0.0032, seed, 4);
  const v = 0.24 + (n - 0.5) * 1.1 + (continent - 0.5) * 1.3 - smoothstep(0.8, 1, d) * 0.9;
  if (v <= 0.2) return VOID;
  if (Math.abs(fbm(x * 0.005, y * 0.005, seed + 11, 4) - 0.5) < 0.016) return VOID;
  if (fbm(x * 0.018, y * 0.018, seed + 5, 3) > 0.7) return VOID;

  // Supply caches: rare, scattered across any solid ground.
  if (hash2(col, row, seed + 41) < 0.0035) return KIND_ID.cache;
  const biome = fbm(x * 0.0042, y * 0.0042, seed + 21, 4);
  const r = hash2(col, row, seed + 3);
  if (biome < 0.4) return r < 0.6 ? KIND_ID.ice : r < 0.7 ? KIND_ID.ore : KIND_ID.rock;
  if (biome > 0.57) return r < 0.38 ? KIND_ID.crystal : r < 0.58 ? KIND_ID.gas : KIND_ID.rock;
  if (fbm(x * 0.011, y * 0.011, seed + 31, 3) > 0.53) return r < 0.05 ? KIND_ID.ruin : KIND_ID.plate;
  return r < 0.16 ? KIND_ID.ore : r < 0.2 ? KIND_ID.ruin : KIND_ID.rock;
}

export const terrainVariant = (p: TerrainParams, col: number, row: number) => Math.floor(hash2(col, row, p.seed + 9) * 4);

/** Fill a chunk's arrays (local index = lr * CS + lc). ~1 ms per chunk. */
export function fillChunk(p: TerrainParams, cx: number, cy: number, kind: Uint8Array, variant?: Uint8Array) {
  for (let lr = 0; lr < CS; lr++) {
    const row = cy * CS + lr;
    for (let lc = 0; lc < CS; lc++) {
      const col = cx * CS + lc, i = lr * CS + lc;
      kind[i] = terrainKind(p, col, row);
      if (variant) variant[i] = terrainVariant(p, col, row);
    }
  }
}
