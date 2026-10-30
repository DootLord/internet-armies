// Zoomed-out rendering. Two levels of detail, both baked to small canvases and
// only rebuilt when their data changes:
//   ChunkMaps  per-chunk map image (3x2 px per hex), from live chunk state
//   WorldMap   whole-world image from procedural terrain + the shard overview;
//              covers chunks we aren't streaming and doubles as the minimap
import { Chunk, CS } from '../chunks';
import { FACTIONS } from '../defs';
import { pick } from '../hex';
import { hex, RGB } from '../palette';
import { terrainKind, VOID } from '../terrain';
import type { Overview } from '../protocol';
import type { WorldView } from '../WorldView';

/**
 * Map colours per terrain kind id (see terrain.KINDS). Deliberately close in
 * value and low in saturation: on a strategic map the territory should pop and
 * terrain should read as quiet texture, never compete with faction colours.
 */
const KIND_RGB: RGB[] = ['#000000', '#283043', '#231f27', '#30261f', '#1f3238', '#26334a', '#2a2337', '#272123', '#3a2f1c', '#283043'].map(hex);
const FACTION_RGB = FACTIONS.map((f) => f.rgb);

export const OV_W = CS * 3 + 1;
export const OV_H = CS * 2;

interface Baked { color: HTMLCanvasElement; emit: HTMLCanvasElement; v: number }

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export class ChunkMaps {
  private baked = new Map<number, Baked>();

  get(c: Chunk) {
    return this.baked.get(c.key);
  }

  /** Re-bake dirty chunks among `chunks`, nearest first, within a time budget. */
  update(view: WorldView, chunks: Chunk[], budgetMs: number) {
    const t0 = performance.now();
    for (const c of chunks) {
      if (!c.terrainReady) continue;
      const b = this.baked.get(c.key);
      if (b && b.v === c.version) continue;
      this.bake(view, c, b);
      if (performance.now() - t0 > budgetMs) break;
    }
    // Drop bakes for chunks the view has evicted.
    for (const k of this.baked.keys()) if (!view.chunks.has(k)) this.baked.delete(k);
  }

  private bake(view: WorldView, c: Chunk, prev?: Baked) {
    const color = prev?.color ?? canvas(OV_W, OV_H), emit = prev?.emit ?? canvas(OV_W, OV_H);
    const cg = color.getContext('2d')!, eg = emit.getContext('2d')!;
    const ci = cg.createImageData(OV_W, OV_H), ei = eg.createImageData(OV_W, OV_H);
    const put = (d: Uint8ClampedArray, x: number, y: number, rgb: RGB, a = 255) => {
      const i = (y * OV_W + x) * 4;
      d[i] = rgb[0]; d[i + 1] = rgb[1]; d[i + 2] = rgb[2]; d[i + 3] = a;
    };
    const live = c.stateReady;
    for (let lr = 0; lr < CS; lr++)
      for (let lc = 0; lc < CS; lc++) {
        const i = lr * CS + lc, k = c.kind[i];
        if (k === VOID) continue;
        const x = lc * 3 + (lr & 1), y = lr * 2;
        const o = c.owner[i];
        let rgb = KIND_RGB[k], border = false;
        if (o >= 0) {
          const col = c.cx * CS + lc, row = c.cy * CS + lr;
          for (const [dc, dr] of NEIGHBOR_OFFSETS[row & 1]) if (view.owner(col + dc, row + dr) !== o) { border = true; break; }
          const f = FACTION_RGB[o];
          const t = border ? 0.9 : 0.45;
          rgb = [rgb[0] + (f[0] - rgb[0]) * t, rgb[1] + (f[1] - rgb[1]) * t, rgb[2] + (f[2] - rgb[2]) * t];
        }
        if (!live) rgb = [rgb[0] * 0.7, rgb[1] * 0.7, rgb[2] * 0.7];
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 3; dx++) put(ci.data, x + dx, y + dy, rgb);
        if (border) for (let dx = 0; dx < 3; dx++) put(ei.data, x + dx, y, FACTION_RGB[o], 150);
        const s = c.structures.get(i);
        if (s) {
          const srgb: RGB = s.kind === 'nexus' ? [255, 255, 255] : FACTION_RGB[s.owner];
          put(ci.data, x + 1, y, srgb);
          put(ei.data, x + 1, y, srgb, 255);
        }
      }
    cg.putImageData(ci, 0, 0);
    eg.putImageData(ei, 0, 0);
    this.baked.set(c.key, { color, emit, v: c.version });
  }
}

// Neighbour offsets for odd-r rows, matching hex.neighbor().
const NEIGHBOR_OFFSETS = [
  [[0, -1], [1, 0], [0, 1], [-1, 1], [-1, 0], [-1, -1]],
  [[1, -1], [1, 0], [1, 1], [0, 1], [-1, 0], [0, -1]],
];

/** World-scale map: terrain sampled from the generator (progressively) + overview ownership. */
export class WorldMap {
  static readonly RES = 512;
  readonly terrain = canvas(WorldMap.RES, WorldMap.RES);
  readonly owners = canvas(1, 1);
  readonly borders = canvas(1, 1);
  readonly composite = canvas(WorldMap.RES, WorldMap.RES);
  private terrainImg: ImageData;
  private nextRow = 0;
  private ovVersion = -1;
  private dirty = true;
  private lastComposite = 0;

  constructor(private view: WorldView) {
    this.terrainImg = this.terrain.getContext('2d')!.createImageData(WorldMap.RES, WorldMap.RES);
  }

  get rect() {
    const R = this.view.params.radiusPx;
    return { x: -R, y: -R, w: 2 * R, h: 2 * R };
  }

  get complete() {
    return this.nextRow >= WorldMap.RES;
  }

  update(budgetMs: number) {
    const N = WorldMap.RES, { x, y, w } = this.rect, px = w / N;
    if (this.nextRow < N) {
      const t0 = performance.now(), d = this.terrainImg.data;
      while (this.nextRow < N && performance.now() - t0 < budgetMs) {
        const j = this.nextRow++;
        for (let i = 0; i < N; i++) {
          const t = pick(x + (i + 0.5) * px, y + (j + 0.5) * px);
          if (!t) continue;
          const k = terrainKind(this.view.params, t[0], t[1]);
          if (k === VOID) continue;
          const rgb = KIND_RGB[k], o = (j * N + i) * 4;
          d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2]; d[o + 3] = 255;
        }
      }
      this.terrain.getContext('2d')!.putImageData(this.terrainImg, 0, 0);
      this.dirty = true;
    }
    const ov = this.view.overview;
    if (ov && ov.version !== this.ovVersion) {
      this.ovVersion = ov.version;
      this.bakeOwners(ov);
      this.dirty = true;
    }
    const now = performance.now();
    if (this.dirty && now - this.lastComposite > 400) {
      this.lastComposite = now;
      this.dirty = false;
      const g = this.composite.getContext('2d')!;
      g.clearRect(0, 0, WorldMap.RES, WorldMap.RES);
      g.drawImage(this.terrain, 0, 0);
      if (ov) {
        g.imageSmoothingEnabled = false;
        const s = WorldMap.RES / w;
        g.globalAlpha = 0.55;
        g.drawImage(this.owners, (ov.x0 - x) * s, (ov.y0 - y) * s, ov.w * ov.cell * s, ov.h * ov.cell * s);
        g.globalAlpha = 1;
        g.drawImage(this.borders, (ov.x0 - x) * s, (ov.y0 - y) * s, ov.w * ov.cell * s, ov.h * ov.cell * s);
      }
    }
  }

  private bakeOwners(ov: Overview) {
    for (const cv of [this.owners, this.borders]) {
      cv.width = ov.w;
      cv.height = ov.h;
    }
    const og = this.owners.getContext('2d')!, bg = this.borders.getContext('2d')!;
    const oi = og.createImageData(ov.w, ov.h), bi = bg.createImageData(ov.w, ov.h);
    const at = (x: number, y: number) => (x < 0 || y < 0 || x >= ov.w || y >= ov.h ? -1 : ov.owner[y * ov.w + x]);
    for (let y = 0; y < ov.h; y++)
      for (let x = 0; x < ov.w; x++) {
        const f = ov.owner[y * ov.w + x];
        if (f < 0) continue;
        const rgb = FACTION_RGB[f], i = (y * ov.w + x) * 4;
        oi.data.set([rgb[0], rgb[1], rgb[2], 255], i);
        if (at(x + 1, y) !== f || at(x - 1, y) !== f || at(x, y + 1) !== f || at(x, y - 1) !== f) bi.data.set([rgb[0], rgb[1], rgb[2], 255], i);
      }
    og.putImageData(oi, 0, 0);
    bg.putImageData(bi, 0, 0);
  }
}
