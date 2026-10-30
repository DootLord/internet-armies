// 2.5D ships: a small voxel model is ray-cast into pixel-art sprites at many
// headings and bank angles, using the same camera, light and material ramps as
// the hex world, so a ship reads as hand-drawn yet rotates consistently.
import { accentRamp, C_WHITE, CRY, mix, OUTLINE, RGB, STEEL } from '../palette';
import { bayer } from '../rng';
import { Pix } from '../sprites';

export const enum Mat { Empty, Hull, Dark, Accent, Glass, Engine, Light }

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
  return { sx, sy, sz, cx, cy, cz, data, normals, engines };
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

export const YAW_STEPS = 64;
export const BANK_LEVELS = 2; // -2..2
export const BANK_ANGLE = 0.3; // radians per level

/** Lazily rendered, cached frames for one model in one faction's colours. */
export class ShipSprites {
  /** Square sprite edge: fits the model's footprint at any heading, plus its height. */
  readonly size: number;
  private frames = new Map<number, ShipFrame>();
  private acc: RGB[];

  constructor(readonly model: VoxelModel, color: RGB) {
    this.acc = accentRamp(color);
    this.size = (Math.ceil(Math.hypot(model.sx, model.sy) + model.sz) + 6) & ~1;
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
