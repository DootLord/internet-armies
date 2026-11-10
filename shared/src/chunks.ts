import { RH, TW } from './hex';
import type { Structure } from './protocol';

/**
 * Tiles per chunk side. A power of two so coordinates split with shifts and
 * masks (which also floor correctly for negative coords), and even so odd-r
 * row parity is the same in chunk-local and global coordinates.
 */
export const CS = 32;
export const CS_BITS = 5;
export const CHUNK_TILES = CS * CS;
export const CHUNK_PX_W = CS * TW;
export const CHUNK_PX_H = CS * RH;

const OFF = 1 << 15;
/** Pack two signed ints (|v| < 32768) into one number: allocation-free Map keys. */
export const pack = (a: number, b: number) => (a + OFF) * 65536 + (b + OFF);
export const unpackA = (k: number) => Math.floor(k / 65536) - OFF;
export const unpackB = (k: number) => (k % 65536) - OFF;

export const chunkOf = (v: number) => v >> CS_BITS;
export const chunkKeyOf = (col: number, row: number) => pack(col >> CS_BITS, row >> CS_BITS);
export const localIndex = (col: number, row: number) => ((row & (CS - 1)) << CS_BITS) | (col & (CS - 1));

/** Client-side chunk: terrain + dynamic state in flat typed arrays (~6 KB). */
export class Chunk {
  readonly kind = new Uint8Array(CHUNK_TILES);
  readonly variant = new Uint8Array(CHUNK_TILES);
  readonly owner = new Int32Array(CHUNK_TILES).fill(-1);
  /** Structures by local index. */
  readonly structures = new Map<number, Structure>();
  terrainReady = false;
  /** Shard revision of the dynamic layer; -1 until the first snapshot lands. */
  rev = -1;
  /** Bumped on any visible change; render caches compare against it. */
  version = 0;
  lastUsed = 0;

  constructor(readonly cx: number, readonly cy: number, readonly key: number) {}

  get stateReady() {
    return this.rev >= 0;
  }
}
