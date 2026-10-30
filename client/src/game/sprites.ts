// Procedural pixel art. Every sprite is painted per-pixel from material ramps with
// ordered dithering, then split into a colour layer (lit by the scene) and an
// emissive layer (feeds bloom). Nothing here is hand-authored art — swap in real
// sprite sheets later by keeping the same {color, emit} shape.
import { FACTIONS, StructureKind, STRUCTURES, TILE_KINDS, TileKind } from './defs';
import { botY, edgeDist, edgeOf, FH, inFace, topY, TW } from './hex';
import {
  accentRamp, C_AMBER, C_CYAN, C_RED, C_VENT, C_WHITE, CRY, css, GAS, hex, ICE, lum, mix, ORE, OUTLINE, PANEL, RGB, ROCK, RUST, STEEL,
} from './palette';
import { bayer, fbm, hash2, mulberry32, smoothstep, vnoise } from './rng';
import { ItemKind, ITEMS } from './ships/cargo';

export const TILE_PAD = 18; // headroom above the face for crystals etc.
const TILE_DEPTH = 22;
export const TILE_SH = TILE_PAD + FH + TILE_DEPTH;
export const SW = 40, SH = 60;
/** Structure sprite offset from tile origin. */
export const SOX = -4, SOY = 14 - 48;

export class Pix {
  readonly d: Uint8ClampedArray;
  constructor(readonly w: number, readonly h: number) {
    this.d = new Uint8ClampedArray(w * h * 4);
  }
  set(x: number, y: number, c: RGB, a = 255) {
    x = Math.floor(x); y = Math.floor(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4, d = this.d;
    d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = a;
  }
  alpha(x: number, y: number) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return 0;
    return this.d[(y * this.w + x) * 4 + 3];
  }
  rgb(x: number, y: number): RGB {
    const i = (y * this.w + x) * 4;
    return [this.d[i], this.d[i + 1], this.d[i + 2]];
  }
  toCanvas() {
    const cv = document.createElement('canvas');
    cv.width = this.w; cv.height = this.h;
    const ctx = cv.getContext('2d')!;
    const img = ctx.createImageData(this.w, this.h);
    img.data.set(this.d);
    ctx.putImageData(img, 0, 0);
    return cv;
  }
}

/** Pick a ramp colour with ordered dithering between steps. */
function pick(r: RGB[], v: number, x: number, y: number): RGB {
  const f = Math.max(0, Math.min(1, v)) * (r.length - 1);
  const i = Math.floor(f);
  return r[Math.min(r.length - 1, f - i > bayer(x, y) ? i + 1 : i)];
}

function line(x0: number, y0: number, x1: number, y1: number, f: (x: number, y: number) => void) {
  const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1, dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    f(x0, y0);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

function ell(cx: number, cy: number, rx: number, ry: number, f: (x: number, y: number, q: number, nx: number, ny: number) => void) {
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++)
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const nx = (x + 0.5 - cx) / rx, ny = (y + 0.5 - cy) / ry, q = nx * nx + ny * ny;
      if (q <= 1) f(x, y, q, nx, ny);
    }
}

// ============================================================== tiles
export interface TileSprite { color: HTMLCanvasElement; emit: HTMLCanvasElement | null; }

const KIND_SEED: Record<TileKind, number> = { void: 0, plate: 11, rock: 23, ore: 37, crystal: 41, ice: 53, gas: 67, ruin: 79, cache: 83, cacheOpen: 89 };

function makeTile(kind: TileKind, variant: number): TileSprite {
  const seed = KIND_SEED[kind] * 97 + variant * 13;
  const rnd = mulberry32(seed);
  const c = new Pix(TW, TILE_SH), e = new Pix(TW, TILE_SH);
  let glows = false;
  const P = TILE_PAD;
  const cache = kind === 'cache' || kind === 'cacheOpen';
  const metal = kind === 'plate' || kind === 'ruin' || cache;
  const R = kind === 'ice' ? ICE : metal ? STEEL : kind === 'gas' ? GAS : ROCK;
  const base = { void: 0, plate: 0.5, ruin: 0.36, rock: 0.5, ore: 0.44, crystal: 0.36, ice: 0.46, gas: 0.45, cache: 0.42, cacheOpen: 0.38 }[kind];
  const rough = metal ? 0.12 : kind === 'ice' ? 0.25 : 0.5;

  // --- top face
  for (let y = 0; y < FH; y++)
    for (let x = 0; x < TW; x++) {
      if (!inFace(x, y)) continue;
      const n = fbm(x * 0.22 + variant * 7, y * 0.3, seed, 3);
      let v = base + (n - 0.5) * rough + ((16 - x) / 32) * 0.12 + ((14 - y) / 28) * 0.14;
      const ty = y - topY(x), by = botY(x) - 1 - y;
      if (ty === 0) v += x < 16 ? 0.3 : 0.18;
      else if (ty === 1 && !metal) v += 0.07;
      if (by === 0) v -= 0.22;
      if (x === 0) v += 0.08;
      if (x === TW - 1) v -= 0.1;
      c.set(x, y + P, pick(R, v, x, y));
    }

  // --- underside / thickness. Rock hangs like an asteroid; metal is a flat slab.
  const jag = (x: number) => vnoise(x * 0.45, variant * 3.1, seed + 5);
  for (let x = 0; x < TW; x++) {
    const dx = x < 16 ? 15 - x : x - 16;
    const depth = metal ? 6 : Math.round(4 + (15 - dx) * (0.45 + 0.35 * jag(x)) + jag(x + 40) * 4);
    const y0 = botY(x);
    for (let k = 0; k < depth; k++) {
      const y = y0 + k;
      let v = (x < 16 ? 0.36 : 0.2) - (k / depth) * 0.18 + (fbm(x * 0.3, y * 0.5, seed + 3, 2) - 0.5) * (metal ? 0.04 : 0.24);
      if (k === 0) v += 0.08;
      if (metal && k === depth - 3) v -= 0.1;
      if (!metal && (y + (x >> 2)) % 5 === 0) v -= 0.06;
      c.set(x, y + P, k === depth - 1 ? R[0] : pick(R, v, x, y));
    }
    if (metal && x % 6 === 3) {
      e.set(x, y0 + 2 + P, kind === 'ruin' ? C_RED : C_CYAN, kind === 'ruin' ? 90 : 120);
      glows = true;
    }
  }

  const face = (x: number, y: number, col: RGB) => { if (inFace(x, y)) c.set(x, y + P, col); };
  const facePts = (n: number, minEdge: number) => {
    const out: [number, number][] = [];
    while (out.length < n) {
      const x = Math.floor(rnd() * TW), y = Math.floor(rnd() * FH);
      if (inFace(x, y) && edgeDist(x, y) >= minEdge) out.push([x, y]);
    }
    return out;
  };

  if (kind === 'plate' || kind === 'ruin' || cache) {
    for (let y = 0; y < FH; y++)
      for (let x = 0; x < TW; x++) {
        if (!inFace(x, y)) continue;
        const d = edgeDist(x, y);
        if (d === 3) face(x, y, STEEL[kind === 'ruin' ? 1 : 2]);
        else if (d === 4) face(x, y, pick(STEEL, kind === 'ruin' ? 0.45 : 0.62, x, y));
        if (d > 4 && variant === 1 && kind === 'plate' && y > 17 && d < 8) face(x, y, (x + y) % 4 < 2 ? hex('#c98a2b') : STEEL[1]);
        if (variant === 2 && Math.abs(x + 0.5 - 16) < 6 && Math.abs(y + 0.5 - 14) < 3) face(x, y, y % 2 ? STEEL[1] : STEEL[4]);
      }
    if (variant === 3) ell(16, 14, 5, 3.2, (x, y, q, nx, ny) => face(x, y, q > 0.6 ? (ny < 0 ? STEEL[1] : STEEL[6]) : STEEL[3]));
    if (variant === 0) for (const [x, y] of [[10, 10], [22, 10], [10, 18], [22, 18]]) face(x, y, STEEL[7]);
    if (kind === 'plate') {
      for (const [x, y] of [[16, 4], [26, 9], [26, 18], [16, 23], [5, 18], [5, 9]]) {
        face(x, y, mix(C_CYAN, C_WHITE, 0.3));
        e.set(x, y + P, C_CYAN, 140);
      }
      glows = true;
    }
  }

  if (cache) {
    // A supply pod on a pad: an isometric crate with a glowing amber seal. Spent ones gape open, dark.
    const open = kind === 'cacheOpen', cx = 16, top = 10, hw = 7, h = 5;
    for (let x = cx - hw; x < cx + hw; x++) {
      const dx = x + 0.5 - cx, a = hw - Math.abs(dx);
      const yb = Math.round(top - a / 2), yf = Math.round(top + a / 2);
      for (let y = yb; y <= yf; y++) c.set(x, y + P, open ? (y === yb ? STEEL[3] : STEEL[0]) : pick(STEEL, 0.7 + (y === yf ? 0.12 : 0), x, y));
      for (let y = yf + 1; y <= yf + h; y++) {
        const seam = y === yf + 2 && !open;
        if (seam) { c.set(x, y + P, mix(C_AMBER, C_WHITE, 0.3)); e.set(x, y + P, C_AMBER, 200); }
        else c.set(x, y + P, pick(STEEL, (dx < 0 ? 0.5 : 0.3) - ((y - yf) / h) * 0.1 + (y === yf + h ? -0.3 : 0), x, y));
      }
      // Raised lid, propped behind the open crate.
      if (open) for (let y = yb - 5; y <= yb - 3; y++) c.set(x, y + P, pick(STEEL, y === yb - 5 ? 0.66 : 0.4, x, y));
    }
    if (!open) {
      c.set(cx, top - 4 + P, mix(C_AMBER, C_WHITE, 0.5));
      e.set(cx, top - 4 + P, C_AMBER, 255);
    }
    glows = true;
  }

  if (kind === 'ruin') {
    for (let y = 0; y < FH; y++)
      for (let x = 0; x < TW; x++) {
        if (!inFace(x, y)) continue;
        const n = fbm(x * 0.2, y * 0.25, seed + 9, 3);
        if (n > 0.56) face(x, y, pick(RUST, (n - 0.56) * 5, x, y));
        if (edgeDist(x, y) < 4 && fbm(x * 0.3, y * 0.3, seed + 4, 2) > 0.63) c.set(x, y + P, [0, 0, 0], 0);
      }
    for (const [x, y] of facePts(5, 5)) { face(x, y, STEEL[7]); face(x, y + 1, STEEL[0]); }
    const [lx, ly] = facePts(1, 6)[0];
    face(lx, ly, mix(C_RED, C_WHITE, 0.4));
    e.set(lx, ly + P, C_RED, 255);
    glows = true;
  }

  if (kind === 'rock' || kind === 'ore' || kind === 'crystal' || kind === 'gas') {
    const craters = kind === 'rock' ? 1 + (variant & 1) : 1;
    for (const [cx, cy] of facePts(craters, 6)) {
      const r = 2 + rnd() * 1.6;
      ell(cx, cy, r, r * 0.7, (x, y, q, nx, ny) => face(x, y, q > 0.55 ? (ny < 0 ? R[1] : R[6]) : R[2]));
    }
    for (const [x, y] of facePts(5, 2)) { face(x, y, R[7] ?? R[6]); face(x, y + 1, R[1]); }
  }

  if (kind === 'ore') {
    for (const [ox, oy] of facePts(7 + variant, 3)) {
      const n = 2 + Math.floor(rnd() * 3);
      for (let i = 0; i < n; i++) {
        const x = ox + Math.floor(rnd() * 3) - 1, y = oy + Math.floor(rnd() * 2);
        const v = 0.35 + rnd() * 0.65;
        face(x, y, pick(ORE, v, x, y));
        if (v > 0.75 && inFace(x, y)) { e.set(x, y + P, ORE[4], 120); glows = true; }
      }
    }
  }

  if (kind === 'ice') {
    for (let i = 0; i < 2; i++) {
      let [x, y] = facePts(1, 4)[0];
      for (let k = 0; k < 10; k++) {
        face(x, y, ICE[2]);
        face(x, y - 1, ICE[6]);
        x += rnd() < 0.5 ? 1 : -1;
        if (rnd() < 0.5) y += rnd() < 0.5 ? 1 : -1;
      }
    }
    for (const [x, y] of facePts(1 + (variant & 1), 4)) { face(x, y, ICE[8]); e.set(x, y + P, C_WHITE, 90); }
    glows = true;
  }

  if (kind === 'gas') {
    for (const [vx, vy] of facePts(2, 6)) {
      ell(vx, vy, 3.2, 2.1, (x, y, q) => {
        if (!inFace(x, y)) return;
        if (q > 0.62) { c.set(x, y + P, mix(C_VENT, GAS[3], 0.4)); e.set(x, y + P, C_VENT, 170); }
        else { c.set(x, y + P, GAS[0]); e.set(x, y + P, mix(C_VENT, [40, 0, 80], 0.5), 110); }
      });
    }
    glows = true;
  }

  if (kind === 'crystal') {
    const shards = Array.from({ length: 3 + (variant % 2) }, () => {
      const [x, y] = facePts(1, 5)[0];
      return { x, y, h: 6 + Math.floor(rnd() * 9), w: 1 + Math.floor(rnd() * 2) };
    }).sort((a, b) => a.y - b.y);
    for (const s of shards) {
      const tip = s.y - s.h;
      for (let y = tip; y <= s.y; y++) {
        const hw = Math.round(s.w * Math.min(1, (y - tip) / (s.h * 0.4)));
        for (let x = s.x - hw; x <= s.x + hw; x++) {
          const edge = x === s.x - hw || x === s.x + hw || y === s.y;
          const col = y === tip ? CRY[6] : edge ? CRY[1] : x < s.x ? CRY[4] : x === s.x ? CRY[5] : CRY[2];
          c.set(x, y + P, col);
          e.set(x, y + P, col, y === tip ? 255 : edge ? 40 : 120);
        }
      }
      ell(s.x, s.y + 1, s.w + 2, 1.4, (x, y) => { if (inFace(x, y) && c.alpha(x, y + P)) e.set(x, y + P, CRY[3], 60); });
    }
    glows = true;
  }

  return { color: c.toCanvas(), emit: glows ? e.toCanvas() : null };
}

// ============================================================== structures
export interface StructSprite {
  color: HTMLCanvasElement;
  emit: HTMLCanvasElement;
  holo: HTMLCanvasElement;
  shine: HTMLCanvasElement;
  beacons: [number, number][];
}

class Painter {
  c = new Pix(SW, SH);
  e = new Pix(SW, SH);
  beacons: [number, number][] = [];
  constructor(readonly acc: RGB[]) {}

  sh(x: number, y: number, R: RGB[], v: number) { this.c.set(x, y, pick(R, v, x, y)); }
  px(x: number, y: number, col: RGB) { this.c.set(x, y, col); }
  glow(x: number, y: number, col: RGB, a = 255) { this.c.set(x, y, mix(col, C_WHITE, 0.35)); this.e.set(x, y, col, a); }
  line(x0: number, y0: number, x1: number, y1: number, col: RGB) { line(x0, y0, x1, y1, (x, y) => this.px(x, y, col)); }

  /** Isometric box with a 2:1 rhombus top. */
  prism(cx: number, top: number, hw: number, h: number, R: RGB[], bias = 0) {
    for (let x = cx - hw; x < cx + hw; x++) {
      const dx = x + 0.5 - cx, a = hw - Math.abs(dx);
      const yb = Math.round(top - a / 2), yf = Math.round(top + a / 2);
      for (let y = yb; y <= yf; y++) {
        let v = 0.72 + bias - ((y - yb) / Math.max(1, yf - yb)) * 0.08;
        if (y === yb) v += 0.08;
        if (y === yf) v += 0.16;
        this.sh(x, y, R, v);
      }
      for (let y = yf + 1; y <= yf + h; y++) {
        let v = (dx < 0 ? 0.5 : 0.28) + bias - ((y - yf) / h) * 0.12;
        if (x === cx - 1) v += 0.12;
        if (y === yf + h) v = 0.1;
        this.sh(x, y, R, v);
      }
    }
  }

  /** y of the prism's front top edge at column x (for decals that follow the faces). */
  prismFront(cx: number, top: number, hw: number, x: number) {
    return Math.round(top + (hw - Math.abs(x + 0.5 - cx)) / 2);
  }

  cyl(cx: number, top: number, r: number, h: number, R: RGB[], bias = 0) {
    for (let x = cx - r; x < cx + r; x++) {
      const dx = (x + 0.5 - cx) / r, e = Math.sqrt(Math.max(0, 1 - dx * dx)) * r * 0.5;
      const yTop = Math.round(top - e), yMid = Math.round(top + e), yBot = Math.round(top + h + e);
      for (let y = yMid; y <= yBot; y++) {
        let v = 0.5 - dx * 0.24 + bias - ((y - yMid) / Math.max(1, yBot - yMid)) * 0.12;
        if (y === yBot) v = 0.1;
        this.sh(x, y, R, v);
      }
      for (let y = yTop; y <= yMid; y++) this.sh(x, y, R, 0.74 + bias - dx * 0.06 + (y === yMid ? 0.14 : 0));
    }
  }

  dome(cx: number, base: number, rx: number, ry: number, R: RGB[], bias = 0) {
    for (let y = Math.floor(base - ry); y <= base; y++)
      for (let x = cx - rx; x < cx + rx; x++) {
        const nx = (x + 0.5 - cx) / rx, ny = (y + 0.5 - base) / ry, q = nx * nx + ny * ny;
        if (q > 1) continue;
        const d = -nx * 0.55 - ny * 0.45 + Math.sqrt(1 - q) * 0.7;
        this.sh(x, y, R, d > 0.93 ? 1 : 0.16 + 0.72 * Math.max(0, d) + bias);
      }
  }

  poly(pts: [number, number][], f: (x: number, y: number, edge: boolean) => void) {
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const inside = (x: number, y: number) => {
      let sign = 0;
      for (let i = 0; i < pts.length; i++) {
        const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
        const cr = (bx - ax) * (y + 0.5 - ay) - (by - ay) * (x + 0.5 - ax);
        if (cr !== 0) { if (sign === 0) sign = Math.sign(cr); else if (Math.sign(cr) !== sign) return false; }
      }
      return true;
    };
    for (let y = Math.min(...ys); y <= Math.max(...ys); y++)
      for (let x = Math.min(...xs); x <= Math.max(...xs); x++)
        if (inside(x, y)) f(x, y, !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1));
  }

  finish(): StructSprite {
    const { c, acc } = this;
    const src = new Uint8ClampedArray(c.d);
    const opaque = (x: number, y: number) => x >= 0 && y >= 0 && x < SW && y < SH && src[(y * SW + x) * 4 + 3] > 0;
    for (let y = 0; y < SH; y++)
      for (let x = 0; x < SW; x++)
        if (!opaque(x, y) && (opaque(x - 1, y) || opaque(x + 1, y) || opaque(x, y - 1) || opaque(x, y + 1))) c.set(x, y, OUTLINE);

    const holo = new Pix(SW, SH), shine = new Pix(SW, SH);
    for (let y = 0; y < SH; y++)
      for (let x = 0; x < SW; x++) {
        if (!c.alpha(x, y)) continue;
        const col = c.rgb(x, y), l = lum(col);
        const isOut = col[0] === OUTLINE[0] && col[1] === OUTLINE[1] && col[2] === OUTLINE[2];
        holo.set(x, y, isOut ? acc[4] : acc[3], Math.round((isOut ? 230 : 60 + l * 190) * (y % 2 ? 0.4 : 1)));
        if (l > 0.42) shine.set(x, y, C_WHITE, Math.min(255, Math.round((l - 0.42) * 700)));
      }
    return { color: c.toCanvas(), emit: this.e.toCanvas(), holo: holo.toCanvas(), shine: shine.toCanvas(), beacons: this.beacons };
  }
}

// ============================================================== cargo items
/** 16 art px per cargo cell; the hold UI scales them by its pixel unit. */
export const ITEM_CELL_PX = 16;
const ITEM_PAINT: Record<ItemKind, (p: Pix) => void> = {
  ore(p) {
    // Three lumps of dark regolith shot through with hot ferrite veins, back to front.
    for (const [cx, cy, rx, ry, seed] of [[21, 12, 8, 7, 2], [11, 18, 9, 8, 1], [21, 23, 9, 6, 3]])
      ell(cx, cy, rx, ry, (x, y, q, nx, ny) => {
        const light = 0.62 - nx * 0.28 - ny * 0.32 + (1 - q) * 0.12;
        if (fbm(x * 0.3, y * 0.3, seed * 17) > 0.6) p.set(x, y, pick(ORE, 0.45 + light * 0.55, x, y));
        else p.set(x, y, pick(ROCK, light, x, y));
      });
  },
  shard(p) {
    // One tall crystal leaning on a stub, lit from the upper left.
    for (const [bx, by, h, w] of [[10, 14, 6, 1], [7, 14, 11, 2]] as [number, number, number, number][])
      for (let y = by - h; y <= by; y++) {
        const hw = Math.round(w * Math.min(1, (y - (by - h)) / (h * 0.4)));
        for (let x = bx - hw; x <= bx + hw; x++) p.set(x, y, y === by - h ? CRY[6] : x < bx ? CRY[5] : x === bx ? CRY[4] : CRY[2]);
      }
  },
  scrap(p) {
    // A buckled plate: riveted steel with rust blooms and a torn edge.
    for (let y = 4; y < 13; y++)
      for (let x = 2; x < 30; x++) {
        const bend = Math.round(Math.sin(x * 0.25) * 1.5);
        const yy = y + bend;
        if (x > 26 && (x + y) % 3 === 0) continue;
        const n = fbm(x * 0.25, y * 0.3, 5);
        p.set(x, yy, n > 0.6 ? pick(RUST, (n - 0.6) * 4, x, yy) : pick(STEEL, 0.62 - (y - 4) * 0.04 + (y === 4 ? 0.15 : 0), x, yy));
      }
    for (const x of [5, 13, 21]) p.set(x, 6 + Math.round(Math.sin(x * 0.25) * 1.5), STEEL[8]);
  },
  fuelcell(p) {
    // Upright canister: rounded steel body, glowing fuel window, capped ends.
    for (let y = 3; y < 30; y++)
      for (let x = 3; x < 13; x++) {
        const dx = (x + 0.5 - 8) / 5, cap = y < 6 || y > 26;
        const v = 0.62 - dx * 0.3 - (cap ? 0.15 : 0);
        p.set(x, y, pick(cap ? STEEL : PANEL, v, x, y));
        if (!cap && y > 10 && y < 22 && Math.abs(dx) < 0.5) p.set(x, y, mix(C_CYAN, C_WHITE, y > 18 ? 0 : 0.35));
      }
  },
  relic(p) {
    // Dark alien lattice: a slab with a carved ring and violet circuitry.
    ell(24, 18, 20, 12, (x, y, q, nx, ny) => {
      const light = 0.5 - nx * 0.25 - ny * 0.3;
      p.set(x, y, pick(GAS, light + (q > 0.85 ? 0.2 : 0), x, y));
      const r = Math.hypot((x + 0.5 - 24) / 9, (y + 0.5 - 17) / 6);
      if (Math.abs(r - 1) < 0.12 || ((x + y) % 7 === 0 && q < 0.6)) p.set(x, y, mix(C_VENT, C_WHITE, 0.25));
    });
    ell(24, 17, 3, 2, (x, y) => p.set(x, y, mix(C_VENT, C_WHITE, 0.6)));
  },
};

const itemArtCache = new Map<ItemKind, string>();
/** A cargo item's portrait as a data URL, outlined like world sprites. */
export function itemArt(kind: ItemKind): string {
  let url = itemArtCache.get(kind);
  if (!url) {
    const { w, h } = ITEMS[kind], W = w * ITEM_CELL_PX, H = h * ITEM_CELL_PX;
    const p = new Pix(W, H);
    ITEM_PAINT[kind](p);
    const src = new Uint8ClampedArray(p.d);
    const solid = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && src[(y * W + x) * 4 + 3] > 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++)
        if (!solid(x, y) && (solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1))) p.set(x, y, OUTLINE);
    itemArtCache.set(kind, (url = p.toCanvas().toDataURL()));
  }
  return url;
}

export interface SpriteShard { color: HTMLCanvasElement; emit: HTMLCanvasElement; w: number; h: number; x: number; y: number }
export interface SpritePixel { x: number; y: number; col: RGB; glow: boolean }

/**
 * The 2D cousin of voxel splitModel: break a painted sprite into jagged chunks
 * (each opaque pixel joins its nearest seed, with jitter), char the broken
 * edges with embers, and sample loose pixels for debris. x/y are sprite-space
 * centres, so every piece starts exactly where it was drawn.
 */
export function fractureSprite(src: { color: HTMLCanvasElement; emit: HTMLCanvasElement }, n: number, seed: number, loose = 260) {
  const W = src.color.width, H = src.color.height;
  const read = (cv: HTMLCanvasElement) => cv.getContext('2d')!.getImageData(0, 0, W, H).data;
  const cd = read(src.color), ed = read(src.emit), rnd = mulberry32(seed);
  const solid: number[] = [];
  for (let i = 0; i < W * H; i++) if (cd[i * 4 + 3]) solid.push(i);
  const seeds = Array.from({ length: n }, () => solid[Math.floor(rnd() * solid.length)]);
  const owner = new Int8Array(W * H).fill(-1);
  for (const i of solid) {
    const x = i % W, y = Math.floor(i / W);
    let best = 0, bd = Infinity;
    seeds.forEach((sd, q) => {
      const d = Math.hypot(x - (sd % W), y - Math.floor(sd / W)) + hash2(x, y, q) * 3;
      if (d < bd) { bd = d; best = q; }
    });
    owner[i] = best;
  }
  const rgb = (d: Uint8ClampedArray, i: number): RGB => [d[i * 4], d[i * 4 + 1], d[i * 4 + 2]];
  const pieces: SpriteShard[] = [];
  for (let q = 0; q < n; q++) {
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (const i of solid) if (owner[i] === q) {
      const x = i % W, y = Math.floor(i / W);
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    if (x1 < 0 || (x1 - x0 + 1) * (y1 - y0 + 1) < 6) continue;
    const w = x1 - x0 + 1, h = y1 - y0 + 1, c = new Pix(w, h), e = new Pix(w, h);
    const other = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && owner[y * W + x] >= 0 && owner[y * W + x] !== q;
    for (const i of solid) {
      if (owner[i] !== q) continue;
      const x = i % W, y = Math.floor(i / W);
      if (other(x - 1, y) || other(x + 1, y) || other(x, y - 1) || other(x, y + 1)) {
        // Broken edge: charred, with the odd ember.
        if (hash2(x, y, 11) < 0.3) { c.set(x - x0, y - y0, mix(C_AMBER, C_WHITE, 0.2)); e.set(x - x0, y - y0, C_AMBER, 170); }
        else c.set(x - x0, y - y0, STEEL[1]);
      } else {
        c.set(x - x0, y - y0, rgb(cd, i));
        if (ed[i * 4 + 3]) e.set(x - x0, y - y0, rgb(ed, i), ed[i * 4 + 3]);
      }
    }
    pieces.push({ color: c.toCanvas(), emit: e.toCanvas(), w, h, x: x0 + w / 2, y: y0 + h / 2 });
  }
  const keep = Math.min(1, loose / solid.length), pixels: SpritePixel[] = [];
  for (const i of solid) if (rnd() < keep) pixels.push({ x: i % W, y: Math.floor(i / W), col: rgb(cd, i), glow: ed[i * 4 + 3] > 100 });
  return { pieces, pixels };
}

const S = STEEL;
const PAINT: Record<StructureKind, (p: Painter) => void> = {
  nexus(p) {
    const a = p.acc;
    p.cyl(8, 37, 3, 7, S); p.glow(8, 33, a[3]);
    p.cyl(32, 37, 3, 7, S); p.glow(32, 33, a[3]);
    p.prism(20, 42, 14, 5, S);
    for (let x = 6; x < 34; x++) {
      const y = p.prismFront(20, 42, 14, x) + 3;
      if (x % 4 === 1) p.glow(x, y, a[2], 200); else p.px(x, y, a[0]);
    }
    p.prism(20, 24, 8, 17, S, 0.04);
    for (const k of [5, 9, 13])
      for (let x = 13; x < 27; x++) {
        if (x % 2 || x === 20) continue;
        p.glow(x, p.prismFront(20, 24, 8, x) + k, x < 20 ? a[3] : a[2], x < 20 ? 255 : 160);
      }
    p.prism(20, 17, 5, 5, S, 0.08);
    p.line(20, 3, 20, 14, S[7]); p.line(19, 6, 19, 14, S[5]);
    p.line(16, 9, 16, 14, S[6]); p.line(24, 9, 24, 14, S[4]);
    p.glow(20, 2, a[4]); p.glow(16, 8, a[3], 200); p.glow(24, 8, a[3], 200);
    p.beacons.push([20, 2]);
  },
  extractor(p) {
    const a = p.acc;
    p.cyl(32, 34, 4, 9, S, -0.05);
    for (let x = 28; x < 36; x++) p.px(x, 40 + (x > 32 ? 1 : 0), a[1]);
    p.cyl(20, 40, 10, 5, S);
    ell(20, 40, 4.5, 2, (x, y, q) => (q > 0.5 ? p.glow(x, y, C_AMBER, 200) : p.glow(x, y, ORE[5], 255)));
    p.line(12, 41, 19, 11, S[6]); p.line(28, 41, 21, 11, S[4]);
    p.line(14, 32, 26, 32, S[3]); p.line(16, 24, 24, 24, S[3]); p.line(17, 18, 23, 18, S[3]);
    p.line(20, 38, 20, 12, S[5]);
    p.prism(20, 9, 4, 4, S, 0.06);
    p.glow(20, 5, a[4]);
    p.beacons.push([20, 5]);
  },
  solar(p) {
    const a = p.acc;
    p.cyl(20, 44, 4, 3, S);
    p.line(20, 44, 20, 32, S[5]); p.line(21, 44, 21, 32, S[3]);
    p.poly([[3, 33], [21, 23], [37, 30], [19, 41]], (x, y, edge) => {
      if (edge) return p.px(x, y, S[6]);
      const grid = (x + 2 * y) % 6 === 0 || (x - 2 * y + 60) % 8 === 0;
      const sheen = Math.max(0, 1 - Math.abs(x - y * 0.6 - 2) / 6) * 0.35;
      p.px(x, y, pick(PANEL, (grid ? 0.55 : 0.28) + sheen + (x / 40) * 0.1, x, y));
      if (!grid) p.e.set(x, y, PANEL[4], 28);
    });
    p.glow(4, 33, a[3]); p.glow(36, 30, a[3]);
    p.prism(31, 42, 4, 3, S); p.glow(31, 44, a[2]);
  },
  habitat(p) {
    const a = p.acc;
    const ring = (front: boolean) =>
      ell(20, 37, 16, 8, (x, y, q) => {
        const inner = ((x + 0.5 - 20) / 10.5) ** 2 + ((y + 0.5 - 37) / 4.8) ** 2;
        if (inner <= 1 || (y >= 37) !== front) return;
        let v = front ? 0.55 : 0.32;
        if (front && q > 0.78) v = 0.24;
        if (!front && inner < 1.3) v = 0.2;
        p.sh(x, y, S, v + (x < 20 ? 0.06 : 0));
        if (front && q > 0.5 && q < 0.72 && x % 3 === 0) p.glow(x, y, a[3], 230);
      });
    ring(false);
    p.cyl(20, 17, 5, 22, S, 0.02);
    p.dome(20, 17, 5, 4, S, 0.05);
    for (let y = 22; y < 38; y += 4) { p.glow(18, y, a[2], 170); }
    p.line(15, 35, 6, 36, S[5]); p.line(25, 35, 34, 36, S[3]);
    ring(true);
    p.glow(20, 11, a[4]);
    p.beacons.push([20, 11]);
  },
  turret(p) {
    const a = p.acc;
    p.prism(20, 42, 11, 5, S, -0.04);
    p.cyl(20, 35, 7, 4, S);
    p.prism(20, 28, 7, 6, S, 0.03);
    for (let i = 0; i < 2; i++) {
      p.line(14, 29 + i * 3, 4, 24 + i * 3, S[7]);
      p.line(14, 30 + i * 3, 4, 25 + i * 3, S[3]);
      p.glow(3, 24 + i * 3, a[4]);
    }
    p.glow(23, 28, a[3]); p.glow(25, 29, a[2], 180);
    for (let x = 10; x < 30; x += 3) p.glow(x, p.prismFront(20, 42, 11, x) + 3, a[1], 160);
    p.beacons.push([23, 28]);
  },
  shield(p) {
    const a = p.acc;
    p.cyl(20, 42, 8, 4, S);
    p.line(12, 44, 16, 22, S[6]); p.line(13, 44, 17, 22, S[4]);
    p.prism(20, 16, 3, 28, S, 0.05);
    p.line(28, 44, 24, 22, S[3]); p.line(27, 44, 23, 22, S[2]);
    for (const y of [26, 34]) ell(20, y, 6, 2, (x, yy, q) => { if (q > 0.45 && yy >= y) p.glow(x, yy, a[2], 190); });
    const gem: [number, number, number][] = [[5, 20, 20], [6, 19, 21], [7, 18, 22], [8, 19, 21], [9, 20, 20]];
    for (const [y, x0, x1] of gem) for (let x = x0; x <= x1; x++) p.glow(x, y, x === 20 && y === 7 ? a[4] : a[3]);
    p.beacons.push([20, 7]);
  },
  relay(p) {
    const a = p.acc;
    p.prism(20, 43, 8, 4, S);
    p.line(20, 42, 20, 22, S[6]); p.line(21, 42, 21, 22, S[3]);
    ell(16, 18, 9, 6, (x, y, q, nx, ny) => p.sh(x, y, S, q > 0.78 ? 0.85 : 0.32 + nx * 0.22 + ny * 0.22));
    p.line(16, 18, 25, 9, S[6]);
    p.glow(26, 8, a[4]); p.glow(16, 18, a[2], 200);
    p.glow(20, 30, a[3], 200);
    p.beacons.push([26, 8]);
  },
  dronebay(p) {
    const a = p.acc;
    p.prism(20, 42, 16, 3, S, -0.06);
    for (let x = 6; x < 34; x += 3) {
      const yf = p.prismFront(20, 42, 16, x), yb = 2 * 42 - yf;
      p.glow(x, yf - 2, a[2], 200);
      if (x > 8 && x < 32) p.glow(x, yb + 2, a[1], 140);
    }
    for (const [x, y] of [[17, 41], [17, 42], [17, 43], [23, 41], [23, 42], [23, 43], [18, 42], [19, 42], [20, 42], [21, 42], [22, 42]]) p.glow(x, y, C_WHITE, 120);
    p.prism(9, 33, 6, 8, S, 0.02);
    for (let y = 35; y < 41; y++) p.glow(14, y, a[3], 220);
    p.px(27, 38, S[6]); p.px(28, 38, S[4]); p.px(26, 38, S[4]); p.glow(27, 37, a[3]);
    p.beacons.push([9, 28]);
    p.glow(9, 28, a[4]);
  },
  depot(p) {
    const a = p.acc;
    p.prism(20, 41, 14, 3, S, -0.04);
    // Two domed tanks with amber level gauges; the nearer one sits lower.
    p.cyl(12, 30, 5, 10, S, 0.02);
    p.dome(12, 30, 5, 4, S, 0.06);
    for (let y = 34; y < 40; y++) p.glow(9, y, C_AMBER, 200);
    p.cyl(25, 32, 6, 9, S);
    p.dome(25, 32, 6, 5, S, 0.04);
    for (let y = 36; y < 41; y++) p.glow(21, y, C_AMBER, 200);
    // Refuelling boom: mast, arm and a glowing nozzle.
    p.line(33, 40, 33, 14, S[6]); p.line(34, 40, 34, 14, S[3]);
    p.line(33, 14, 24, 10, S[6]); p.line(24, 10, 24, 16, S[4]);
    p.glow(24, 17, a[4]);
    for (let x = 8; x < 33; x += 3) p.glow(x, p.prismFront(20, 41, 14, x) + 2, a[2], 180);
    p.glow(33, 13, a[4]);
    p.beacons.push([33, 13]);
  },
  storage(p) {
    const a = p.acc;
    p.prism(20, 41, 15, 3, S, -0.04);
    // Stacked container modules: two on the deck, one on top, faction-striped.
    for (const [cx, top, hw, h] of [[12, 32, 7, 7], [27, 33, 7, 7], [19, 23, 8, 7]] as [number, number, number, number][]) {
      p.prism(cx, top, hw, h, S, 0.02);
      for (let x = cx - hw + 1; x < cx + hw - 1; x += 2) p.px(x, p.prismFront(cx, top, hw, x) + 3, S[2]);
      for (let x = cx - hw; x < cx + hw; x++) p.glow(x, p.prismFront(cx, top, hw, x) + h - 1, a[2], 150);
    }
    // Loading arm over the stack.
    p.line(35, 40, 35, 12, S[6]); p.line(36, 40, 36, 12, S[3]);
    p.line(35, 12, 22, 12, S[6]); p.line(22, 12, 22, 16, S[4]);
    p.glow(22, 17, C_AMBER, 220);
    p.glow(35, 11, a[4]);
    p.beacons.push([35, 11]);
  },
};

// ============================================================== shared overlays
const EDGE_PX: [number, number][][] = [[], [], [], [], [], []];
const FACE_PX: [number, number][] = [];
for (let y = 0; y < FH; y++)
  for (let x = 0; x < TW; x++) {
    if (!inFace(x, y)) continue;
    FACE_PX.push([x, y]);
    if (!inFace(x - 1, y) || !inFace(x + 1, y) || !inFace(x, y - 1) || !inFace(x, y + 1)) EDGE_PX[edgeOf(x, y)].push([x, y]);
  }

function hexCanvas(pts: [number, number][], col: RGB, a = 255) {
  const p = new Pix(TW, FH);
  for (const [x, y] of pts) p.set(x, y, col, a);
  return p.toCanvas();
}

// ============================================================== registry
export interface Star { x: number; y: number; b: number; ph: number; big: boolean }

class Assets {
  ready = false;
  private tiles = new Map<string, TileSprite>();
  private structs = new Map<string, StructSprite>();
  private lights = new Map<string, HTMLCanvasElement>();
  private outlines = new Map<string, HTMLCanvasElement>();
  private fills = new Map<string, HTMLCanvasElement>();
  edges: HTMLCanvasElement[][] = [];
  domes: HTMLCanvasElement[] = [];
  chevrons: HTMLCanvasElement[] = [];
  nebula!: HTMLCanvasElement;
  stars: { p: number; list: Star[] }[] = [];
  private icons = new Map<string, string>();

  init() {
    if (this.ready) return;
    this.ready = true;
    for (const k of TILE_KINDS) for (let v = 0; v < 4; v++) this.tiles.set(`${k}${v}`, makeTile(k, v));
    for (const f of FACTIONS) {
      const acc = accentRamp(f.rgb);
      for (const s of STRUCTURES) {
        const p = new Painter(acc);
        PAINT[s.kind](p);
        this.structs.set(`${s.kind}${f.id}`, p.finish());
      }
      this.edges[f.id] = EDGE_PX.map((pts) => hexCanvas(pts, acc[3]));
      this.domes[f.id] = makeDome(acc);
      this.chevrons[f.id] = makeChevron(acc[4]);
    }
    this.nebula = makeNebula(1337);
    this.stars = makeStars(99);
  }

  tile(kind: TileKind, variant: number) { return this.tiles.get(`${kind}${variant}`)!; }
  structure(kind: StructureKind, owner: number) { return this.structs.get(`${kind}${owner}`)!; }

  light(col: string) {
    let cv = this.lights.get(col);
    if (!cv) {
      cv = document.createElement('canvas');
      cv.width = cv.height = 64;
      const g = cv.getContext('2d')!;
      const c = hex(col);
      const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      grad.addColorStop(0, css(c, 1));
      grad.addColorStop(0.3, css(c, 0.45));
      grad.addColorStop(1, css(c, 0));
      g.fillStyle = grad;
      g.fillRect(0, 0, 64, 64);
      this.lights.set(col, cv);
    }
    return cv;
  }
  outline(col: string) {
    let cv = this.outlines.get(col);
    if (!cv) this.outlines.set(col, (cv = hexCanvas(EDGE_PX.flat(), hex(col))));
    return cv;
  }
  fill(col: string) {
    let cv = this.fills.get(col);
    if (!cv) this.fills.set(col, (cv = hexCanvas(FACE_PX, hex(col))));
    return cv;
  }

  private tileIcons = new Map<string, string>();
  tileIcon(kind: TileKind, variant: number) {
    const key = `${kind}${variant}`;
    let url = this.tileIcons.get(key);
    if (!url) this.tileIcons.set(key, (url = this.tile(kind, variant).color.toDataURL()));
    return url;
  }

  /**
   * Structure on a plate, in its owner's colours, for UI portraits. Same layer
   * split as the world: 'color', 'emit', 'shine' (glint mask), plus 'bloom':
   * the emit layer pre-blurred and summed, standing in for the WebGL bloom pass.
   */
  icon(kind: StructureKind, owner = 0, layer: 'color' | 'emit' | 'shine' | 'bloom' = 'color') {
    const key = `${kind}${owner}${layer}`;
    let url = this.icons.get(key);
    if (!url) {
      const cv = document.createElement('canvas');
      cv.width = 40; cv.height = 70;
      const g = cv.getContext('2d')!;
      const tile = this.tile('plate', 3), s = this.structure(kind, owner);
      if (layer === 'bloom') {
        // Two radii summed additively, like the dual-kawase chain in post.ts.
        const emit = document.createElement('canvas');
        emit.width = 40; emit.height = 70;
        const eg = emit.getContext('2d')!;
        if (tile.emit) eg.drawImage(tile.emit, 4, 34 - TILE_PAD);
        eg.drawImage(s.emit, 0, 0);
        g.globalCompositeOperation = 'lighter';
        for (const [blur, passes] of [[1, 3], [3, 3]]) {
          g.filter = `blur(${blur}px)`;
          for (let i = 0; i < passes; i++) g.drawImage(emit, 0, 0);
        }
      } else {
        if (layer === 'color') g.drawImage(tile.color, 4, 34 - TILE_PAD);
        if (layer === 'emit' && tile.emit) g.drawImage(tile.emit, 4, 34 - TILE_PAD);
        g.drawImage(s[layer], 0, 0);
      }
      this.icons.set(key, (url = cv.toDataURL()));
    }
    return url;
  }
}
export const assets = new Assets();

function makeDome(acc: RGB[]) {
  const p = new Pix(46, 42);
  for (let y = 0; y < 42; y++)
    for (let x = 0; x < 46; x++) {
      const nx = (x + 0.5 - 23) / 22, ny = y + 0.5 < 32 ? (y + 0.5 - 32) / 30 : (y + 0.5 - 32) / 8;
      const d = Math.sqrt(nx * nx + ny * ny);
      if (d > 1) continue;
      const hexPat = (x + 2 * y) % 8 === 0 || (x - 2 * y + 400) % 8 === 0;
      const hl = smoothstep(0.4, 1, -nx * 0.6 - ny * 0.8);
      const a = d > 0.92 ? 200 : hexPat ? 50 + hl * 80 : hl * 60;
      if (a > 4) p.set(x, y, d > 0.92 ? acc[3] : acc[2], Math.round(a));
    }
  return p.toCanvas();
}

function makeChevron(col: RGB) {
  const rows = ['X.....X', 'XX...XX', '.XX.XX.', '..XXX..', '...X...'];
  const p = new Pix(7, 5);
  rows.forEach((r, y) => [...r].forEach((ch, x) => ch === 'X' && p.set(x, y, col)));
  return p.toCanvas();
}

function makeNebula(seed: number) {
  // Generated at half resolution and drawn at 2x for chunky, painterly pixels.
  const W = 760, H = 600;
  const p = new Pix(W, H);
  const SPACE = hex('#03040a'), TEAL = hex('#0f4b66'), VIOLET = hex('#3d1d66'), WARM = hex('#b5603b'), DEEP = hex('#081428');
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const n = fbm(x * 0.0055, y * 0.0055, seed, 5);
      const m = fbm(x * 0.016 + 9, y * 0.016, seed + 1, 3);
      const dens = smoothstep(0.44, 0.74, n * 0.78 + m * 0.22);
      const q = Math.floor(dens * 6 + bayer(x, y) - 0.25) / 6;
      const hue = smoothstep(0.38, 0.62, fbm(x * 0.0035, y * 0.0035, seed + 2, 2));
      let col = mix(SPACE, DEEP, smoothstep(0.3, 0.6, n));
      if (q > 0) col = mix(col, mix(TEAL, VIOLET, hue), Math.min(1, q * 0.85));
      if (q > 0.6) col = mix(col, WARM, (q - 0.6) * 0.9 * (1 - hue * 0.5));
      const dust = fbm(x * 0.02, y * 0.02, seed + 3, 3);
      if (dust > 0.6) col = mix(col, SPACE, Math.min(0.7, (dust - 0.6) * 4));
      p.set(x, y, col);
    }
  return p.toCanvas();
}

function makeStars(seed: number) {
  const rnd = mulberry32(seed);
  return [
    { p: 0.04, n: 900 },
    { p: 0.09, n: 420 },
    { p: 0.16, n: 90 },
  ].map(({ p, n }, li) => ({
    p,
    list: Array.from({ length: n }, () => ({
      x: rnd() * 2048, y: rnd() * 2048, b: 0.25 + rnd() * (0.35 + li * 0.25), ph: rnd() * 6.28, big: li === 2 && rnd() < 0.35,
    })),
  }));
}

export const STAR_DOMAIN = 2048;
