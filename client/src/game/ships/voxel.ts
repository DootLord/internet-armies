// 2.5D ships: a small voxel model is ray-cast into pixel-art sprites at many
// headings and bank angles, using the same camera, light and material ramps as
// the hex world, so a ship reads as hand-drawn yet rotates consistently.
import { accentRamp, C_AMBER, C_WHITE, CRY, mix, OUTLINE, RGB, ROCK, STEEL } from '../palette';
import { bayer, hash2, mulberry32 } from '../rng';
import { Pix } from '../sprites';

/** Scorch is never authored by shapes; damageModel() burns it into a hull. Rock is for cargo items like ore. */
export const enum Mat { Empty, Hull, Dark, Accent, Glass, Engine, Light, Scorch, Rock }

export interface VoxelModel {
  sx: number;
  sy: number;
  sz: number;
  /** Model-space origin inside the grid (voxel units). */
  cx: number;
  cy: number;
  cz: number;
  data: Uint8Array;
  normals: Float32Array;
  /** Model-space points engines exhaust from (x forward, y right, z up). */
  engines: [number, number, number][];
}

/** Build a voxel model from a material function over model space (x fwd, y right, z up). */
export function buildModel(
  sx: number, sy: number, sz: number,
  shape: (x: number, y: number, z: number) => Mat,
  engines: [number, number, number][],
): VoxelModel {
  const cx = sx / 2, cy = sy / 2, cz = sz / 2;
  const data = new Uint8Array(sx * sy * sz);
  for (let k = 0; k < sz; k++)
    for (let j = 0; j < sy; j++)
      for (let i = 0; i < sx; i++) data[(k * sy + j) * sx + i] = shape(i + 0.5 - cx, j + 0.5 - cy, k + 0.5 - cz);
  return { sx, sy, sz, cx, cy, cz, data, normals: computeNormals(sx, sy, sz, data), engines };
}

function computeNormals(sx: number, sy: number, sz: number, data: Uint8Array) {
  // Smooth normals from the occupancy gradient over a 3x3x3 neighbourhood.
  const normals = new Float32Array(sx * sy * sz * 3);
  const solid = (i: number, j: number, k: number) => i >= 0 && j >= 0 && k >= 0 && i < sx && j < sy && k < sz && data[(k * sy + j) * sx + i] !== 0;
  for (let k = 0; k < sz; k++)
    for (let j = 0; j < sy; j++)
      for (let i = 0; i < sx; i++) {
        const idx = (k * sy + j) * sx + i;
        if (!data[idx]) continue;
        let nx = 0, ny = 0, nz = 0;
        for (let dk = -1; dk <= 1; dk++)
          for (let dj = -1; dj <= 1; dj++)
            for (let di = -1; di <= 1; di++)
              if (solid(i + di, j + dj, k + dk)) { nx -= di; ny -= dj; nz -= dk; }
        const l = Math.hypot(nx, ny, nz);
        // Fully buried voxels have no gradient; they're never visible, so any normal will do.
        normals[idx * 3] = l ? nx / l : 0;
        normals[idx * 3 + 1] = l ? ny / l : 0;
        normals[idx * 3 + 2] = l ? nz / l : 1;
      }
  return normals;
}

type Vec = [number, number, number];

/**
 * Where a hull takes its wounds: up-facing surface points (so the craters are
 * visible from the camera), spread apart, and seeded so a hull always breaks
 * the same way. Model space, like engines.
 */
export function pickHits(m: VoxelModel, n: number, seed: number): Vec[] {
  const cand: Vec[] = [];
  for (let k = 0; k < m.sz; k++)
    for (let j = 0; j < m.sy; j++)
      for (let i = 0; i < m.sx; i++) {
        const idx = (k * m.sy + j) * m.sx + i, mat = m.data[idx];
        if (mat === Mat.Hull || mat === Mat.Dark || mat === Mat.Accent)
          if (m.normals[idx * 3 + 2] > 0.4) cand.push([i + 0.5 - m.cx, j + 0.5 - m.cy, k + 0.5 - m.cz]);
      }
  const rnd = mulberry32(seed), out: Vec[] = [];
  const gap = Math.max(m.sx, m.sy) / (n + 1);
  for (let tries = 0; out.length < n && tries < 400 && cand.length; tries++) {
    const p = cand[Math.floor(rnd() * cand.length)];
    if (out.every((q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) > gap)) out.push(p);
  }
  return out;
}

/** A copy of the model with a scorched crater blown into it at each hit. */
export function damageModel(m: VoxelModel, hits: Vec[], radius: number): VoxelModel {
  const data = new Uint8Array(m.data);
  for (let k = 0; k < m.sz; k++)
    for (let j = 0; j < m.sy; j++)
      for (let i = 0; i < m.sx; i++) {
        const idx = (k * m.sy + j) * m.sx + i;
        if (!data[idx]) continue;
        const x = i + 0.5 - m.cx, y = j + 0.5 - m.cy, z = k + 0.5 - m.cz;
        // Ragged edges: jitter the radius per voxel so craters aren't perfect spheres.
        const r = radius * (0.75 + 0.5 * hash2(i * 7 + k, j * 13 - k));
        let d = Infinity;
        for (const h of hits) d = Math.min(d, Math.hypot(x - h[0], y - h[1], z - h[2]));
        if (d < r) data[idx] = Mat.Empty;
        else if (d < r + 1.6) data[idx] = Mat.Scorch;
      }
  return { ...m, data, normals: computeNormals(m.sx, m.sy, m.sz, data) };
}

// Camera: the hex world's ground plane is squashed to 0.76 (sin of the pitch);
// heights project at 0.65 (cos). A ray toward the camera is (0, COS, SIN).
export const PITCH_SIN = 0.76;
export const PITCH_COS = 0.65;
const LIGHT = (() => {
  const l = [-0.45, -0.45, 0.77], n = Math.hypot(...l);
  return l.map((v) => v / n) as [number, number, number];
})();
const HALF = (() => {
  const h = [LIGHT[0], LIGHT[1] + PITCH_COS, LIGHT[2] + PITCH_SIN], n = Math.hypot(...h);
  return h.map((v) => v / n) as [number, number, number];
})();

/** Project a model-space point to sprite-centre-relative screen offset for a given pose. */
export function projectPoint(p: [number, number, number], yaw: number, roll: number): [number, number] {
  const [mx, my0, mz0] = p;
  const cr = Math.cos(roll), sr = Math.sin(roll);
  const my = my0 * cr - mz0 * sr, mz = my0 * sr + mz0 * cr;
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const gx = mx * cy - my * sy, gy = mx * sy + my * cy;
  return [gx, gy * PITCH_SIN - mz * PITCH_COS];
}

export interface ShipFrame { color: HTMLCanvasElement; emit: HTMLCanvasElement }

export function renderFrame(m: VoxelModel, yaw: number, roll: number, acc: RGB[], size: number): ShipFrame {
  const c = new Pix(size, size), e = new Pix(size, size);
  const depth = new Float32Array(size * size).fill(-Infinity);
  const mats = new Uint8Array(size * size);
  const shade = new Float32Array(size * size);
  const cyw = Math.cos(yaw), syw = Math.sin(yaw), cr = Math.cos(roll), sr = Math.sin(roll);
  const R = Math.hypot(m.cx, m.cy, m.cz) + 1;
  const half = size / 2;

  for (let py = 0; py < size; py++)
    for (let px = 0; px < size; px++) {
      const sx = px + 0.5 - half, sy = py + 0.5 - half;
      if (Math.abs(sx) > R) continue;
      // Points on this pixel's ray: g = (sx, sy/SIN + t*COS, t*SIN). Larger t = closer to camera.
      const tz = R / PITCH_SIN;
      const tA = (-R - sy / PITCH_SIN) / PITCH_COS, tB = (R - sy / PITCH_SIN) / PITCH_COS;
      const tMax = Math.min(tz, tB), tMin = Math.max(-tz, tA);
      for (let t = tMax; t >= tMin; t -= 0.4) {
        const gx = sx, gy = sy / PITCH_SIN + t * PITCH_COS, gz = t * PITCH_SIN;
        // World -> model: un-yaw, then un-roll.
        const mx = gx * cyw + gy * syw, my1 = -gx * syw + gy * cyw;
        const my = my1 * cr + gz * sr, mz = -my1 * sr + gz * cr;
        const i = Math.floor(mx + m.cx), j = Math.floor(my + m.cy), k = Math.floor(mz + m.cz);
        if (i < 0 || j < 0 || k < 0 || i >= m.sx || j >= m.sy || k >= m.sz) continue;
        const idx = (k * m.sy + j) * m.sx + i, mat = m.data[idx];
        if (!mat) continue;
        // Model normal -> world (roll, then yaw).
        const nx = m.normals[idx * 3], ny0 = m.normals[idx * 3 + 1], nz0 = m.normals[idx * 3 + 2];
        const ny1 = ny0 * cr - nz0 * sr, nz = ny0 * sr + nz0 * cr;
        const wx = nx * cyw - ny1 * syw, wy = nx * syw + ny1 * cyw;
        const diff = Math.max(0, wx * LIGHT[0] + wy * LIGHT[1] + nz * LIGHT[2]);
        // Tight highlight: voxel-gradient normals are coarse, so a broad one speckles.
        const spec = Math.pow(Math.max(0, wx * HALF[0] + wy * HALF[1] + nz * HALF[2]), 40);
        const p = py * size + px;
        depth[p] = t;
        mats[p] = mat;
        shade[p] = 0.2 + 0.6 * diff + 0.45 * spec;
        break;
      }
    }

  // Narrow dither band: flats resolve to a clean ramp step, and only values near
  // a midpoint dither. Full-range dithering turns smooth hulls into checkerboards.
  const pick = (r: RGB[], v: number, x: number, y: number) => {
    const f = Math.max(0, Math.min(1, v)) * (r.length - 1), i = Math.floor(f);
    return r[Math.min(r.length - 1, f - i > 0.5 + (bayer(x, y) - 0.5) * 0.5 ? i + 1 : i)];
  };
  for (let py = 0; py < size; py++)
    for (let px = 0; px < size; px++) {
      const p = py * size + px, mat = mats[p];
      if (!mat) continue;
      let v = shade[p];
      // Inner outline where a nearer surface overlaps this one (wing over hull, etc).
      const t = depth[p];
      const crease = [p - 1, p + 1, p - size, p + size].some((q) => q >= 0 && q < size * size && mats[q] && depth[q] > t + 2.2);
      if (crease) v *= 0.45;
      switch (mat) {
        case Mat.Hull: c.set(px, py, pick(STEEL, v, px, py)); break;
        case Mat.Dark: c.set(px, py, pick(STEEL, v * 0.62, px, py)); break;
        case Mat.Accent: c.set(px, py, pick(acc, 0.15 + v * 0.85, px, py)); break;
        case Mat.Glass:
          // Dark tinted glass with a faint inner glow; the faction colour lives on the wings.
          c.set(px, py, pick(CRY, 0.08 + v * 0.45, px, py));
          e.set(px, py, CRY[3], 45);
          break;
        case Mat.Engine:
          // Solid patches of full emissive bloom into blobs; keep nozzles a
          // touch under full and let the exhaust particles carry the burn.
          c.set(px, py, mix(acc[3], C_WHITE, 0.3));
          e.set(px, py, acc[2], 120);
          break;
        case Mat.Light:
          c.set(px, py, C_WHITE);
          e.set(px, py, C_WHITE, 255);
          break;
        case Mat.Rock: c.set(px, py, pick(ROCK, v, px, py)); break;
        case Mat.Scorch:
          // Charred plating with the odd ember still glowing in it.
          if (hash2(px, py, 7) < 0.1) {
            c.set(px, py, mix(acc[3], C_AMBER, 0.7));
            e.set(px, py, C_AMBER, 150);
          } else c.set(px, py, pick(STEEL, v * 0.3, px, py));
          break;
      }
    }

  // Silhouette outline, same as world structures.
  const src = new Uint8Array(mats);
  for (let py = 0; py < size; py++)
    for (let px = 0; px < size; px++) {
      const p = py * size + px;
      if (src[p]) continue;
      if ((px > 0 && src[p - 1]) || (px < size - 1 && src[p + 1]) || (py > 0 && src[p - size]) || (py < size - 1 && src[p + size])) c.set(px, py, OUTLINE);
    }
  return { color: c.toCanvas(), emit: e.toCanvas() };
}

export interface Shard { x: number; y: number; vx: number; vy: number; col: RGB; glow: boolean }

/**
 * Break a model into flying debris: a sample of its surface voxels, each pushed
 * outward from the centre in model space and projected for the current pose,
 * so the burst inherits the ship's real shape and colours.
 */
export function shatter(m: VoxelModel, yaw: number, roll: number, acc: RGB[], max = 420): Shard[] {
  const { sx, sy, sz, data } = m;
  const at = (i: number, j: number, k: number) => i >= 0 && j >= 0 && k >= 0 && i < sx && j < sy && k < sz && data[(k * sy + j) * sx + i] !== 0;
  const surface: number[] = [];
  for (let k = 0; k < sz; k++)
    for (let j = 0; j < sy; j++)
      for (let i = 0; i < sx; i++)
        if (at(i, j, k) && !(at(i - 1, j, k) && at(i + 1, j, k) && at(i, j - 1, k) && at(i, j + 1, k) && at(i, j, k - 1) && at(i, j, k + 1)))
          surface.push(i, j, k);
  const keep = Math.min(1, max / (surface.length / 3));
  const r = () => Math.random() - 0.5;
  const out: Shard[] = [];
  for (let n = 0; n < surface.length; n += 3) {
    if (Math.random() > keep) continue;
    const [i, j, k] = [surface[n], surface[n + 1], surface[n + 2]];
    const p: [number, number, number] = [i + 0.5 - m.cx, j + 0.5 - m.cy, k + 0.5 - m.cz];
    const d = Math.hypot(...p) || 1, sp = 20 + Math.random() * 60;
    // Projection is linear, so it maps velocities as well as positions. The
    // upward kick makes the burst read as 3D rather than a flat ring.
    const [x, y] = projectPoint(p, yaw, roll);
    const [vx, vy] = projectPoint([(p[0] / d) * sp + r() * 25, (p[1] / d) * sp + r() * 25, (p[2] / d) * sp + 15 + r() * 30], yaw, roll);
    const mat = data[(k * sy + j) * sx + i] as Mat;
    const col = mat === Mat.Accent ? acc[2] : mat === Mat.Glass ? CRY[4] : mat === Mat.Engine ? acc[3] : mat === Mat.Light ? C_WHITE
      : STEEL[mat === Mat.Dark ? 4 : 5 + Math.floor(Math.random() * 3)];
    out.push({ x, y, vx, vy, col, glow: mat === Mat.Glass || mat === Mat.Engine || mat === Mat.Light });
  }
  return out;
}

export interface Piece { model: VoxelModel; offset: Vec }

/**
 * Fracture a model into `n` chunks: every solid voxel joins its nearest seed
 * (with jitter, so the breaks are jagged), and voxels on a break are scorched.
 * Each chunk is its own cropped model, centred on itself, plus where that
 * centre sat in the parent, so it can start exactly where it was.
 */
export function splitModel(m: VoxelModel, n: number, seed: number): Piece[] {
  const { sx, sy, sz, data } = m, rnd = mulberry32(seed);
  const solid: number[] = [];
  for (let idx = 0; idx < data.length; idx++) if (data[idx]) solid.push(idx);
  const seeds = Array.from({ length: n }, () => solid[Math.floor(rnd() * solid.length)]).map((idx) => [idx % sx, Math.floor(idx / sx) % sy, Math.floor(idx / (sx * sy))]);
  const owner = new Int8Array(data.length).fill(-1);
  for (const idx of solid) {
    const i = idx % sx, j = Math.floor(idx / sx) % sy, k = Math.floor(idx / (sx * sy));
    let best = 0, bd = Infinity;
    seeds.forEach(([a, b, c], q) => {
      const d = Math.hypot(i - a, j - b, k - c) + hash2(i * 3 + k, j * 5 - k, q) * 3;
      if (d < bd) { bd = d; best = q; }
    });
    owner[idx] = best;
  }
  const out: Piece[] = [];
  for (let q = 0; q < n; q++) {
    let x0 = sx, y0 = sy, z0 = sz, x1 = -1, y1 = -1, z1 = -1, count = 0;
    for (const idx of solid) {
      if (owner[idx] !== q) continue;
      const i = idx % sx, j = Math.floor(idx / sx) % sy, k = Math.floor(idx / (sx * sy));
      x0 = Math.min(x0, i); y0 = Math.min(y0, j); z0 = Math.min(z0, k);
      x1 = Math.max(x1, i); y1 = Math.max(y1, j); z1 = Math.max(z1, k);
      count++;
    }
    if (count < 12) continue;
    const w = x1 - x0 + 1, h = y1 - y0 + 1, d = z1 - z0 + 1, pd = new Uint8Array(w * h * d);
    const other = (i: number, j: number, k: number) => i >= 0 && j >= 0 && k >= 0 && i < sx && j < sy && k < sz && owner[(k * sy + j) * sx + i] >= 0 && owner[(k * sy + j) * sx + i] !== q;
    for (let k = z0; k <= z1; k++)
      for (let j = y0; j <= y1; j++)
        for (let i = x0; i <= x1; i++) {
          const idx = (k * sy + j) * sx + i;
          if (owner[idx] !== q) continue;
          const broken = other(i - 1, j, k) || other(i + 1, j, k) || other(i, j - 1, k) || other(i, j + 1, k) || other(i, j, k - 1) || other(i, j, k + 1);
          pd[((k - z0) * h + (j - y0)) * w + (i - x0)] = broken && data[idx] !== Mat.Engine ? Mat.Scorch : data[idx];
        }
    const piece: VoxelModel = { sx: w, sy: h, sz: d, cx: w / 2, cy: h / 2, cz: d / 2, data: pd, normals: computeNormals(w, h, d, pd), engines: [] };
    out.push({ model: piece, offset: [x0 + w / 2 - m.cx, y0 + h / 2 - m.cy, z0 + d / 2 - m.cz] });
  }
  return out;
}

export const YAW_STEPS = 64;
/** Tumbling wreckage is quantized coarser than flight: it never holds still long enough to notice. */
const TUMBLE_YAW = 32, TUMBLE_ROLL = 16;
export const BANK_LEVELS = 2; // -2..2
export const BANK_ANGLE = 0.3; // radians per level

/** Lazily rendered, cached frames for one model in one faction's colours. */
export class ShipSprites {
  /** Square sprite edge: fits the model's footprint at any heading, plus its height. */
  readonly size: number;
  private frames = new Map<number, ShipFrame>();
  private acc: RGB[];

  /** `tumble` sizes the sprite for any orientation, not just near-level flight. */
  constructor(readonly model: VoxelModel, color: RGB, tumble = false) {
    this.acc = accentRamp(color);
    const { sx, sy, sz } = model;
    this.size = (Math.ceil(tumble ? Math.hypot(sx, sy, sz) * 1.1 : Math.hypot(sx, sy) + sz) + 6) & ~1;
  }

  static yawIndex(heading: number) {
    const n = YAW_STEPS;
    return ((Math.round((heading / (Math.PI * 2)) * n) % n) + n) % n;
  }

  frame(yawIdx: number, bank: number): ShipFrame {
    const key = yawIdx * 16 + bank + BANK_LEVELS;
    let f = this.frames.get(key);
    if (!f) {
      f = renderFrame(this.model, (yawIdx / YAW_STEPS) * Math.PI * 2, bank * BANK_ANGLE, this.acc, this.size);
      this.frames.set(key, f);
    }
    return f;
  }

  /** Any orientation, quantized and cached: for tumbling wreckage rather than flight. */
  pose(yaw: number, roll: number): ShipFrame {
    const wrap = (a: number, n: number) => ((Math.round((a / (Math.PI * 2)) * n) % n) + n) % n;
    const yi = wrap(yaw, TUMBLE_YAW), ri = wrap(roll, TUMBLE_ROLL), key = 100000 + yi * TUMBLE_ROLL + ri;
    let f = this.frames.get(key);
    if (!f) {
      f = renderFrame(this.model, (yi / TUMBLE_YAW) * Math.PI * 2, (ri / TUMBLE_ROLL) * Math.PI * 2, this.acc, this.size);
      this.frames.set(key, f);
    }
    return f;
  }

  /** Pre-render frames in the background, level flight first, within a time budget. */
  warm(budgetMs: number) {
    if (this.frames.size >= YAW_STEPS * (BANK_LEVELS * 2 + 1)) return;
    const t0 = performance.now();
    for (const b of [0, 1, -1, 2, -2])
      for (let y = 0; y < YAW_STEPS; y++) {
        if (this.frames.has(y * 16 + b + BANK_LEVELS)) continue;
        this.frame(y, b);
        if (performance.now() - t0 > budgetMs) return;
      }
  }
}
