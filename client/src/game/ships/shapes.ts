// Hull shapes as material functions over model space: x forward (nose +),
// y right, z up; one unit = one art pixel before scaling. Each is ray-cast
// into sprites by voxel.ts, so a new hull is just a new function here.
import { buildModel, damageModel, Mat, pickHits, VoxelModel } from './voxel';

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
type Shape = (x: number, y: number, z: number) => Mat;
type Vec = [number, number, number];

/** Collects the highest-priority material claimed at a point (Engine > Accent > Hull...). */
function picker() {
  let m = Mat.Empty;
  return { take: (v: Mat) => { if (v > m) m = v; }, get: () => m };
}

// ---------------------------------------------------------------- Lancer: strike cruiser
const lancer: Shape = (x, y, z) => {
  const ay = Math.abs(y), p = picker();
  // Fuselage: swells amidships, tapers to a forked prow, ridged spine.
  if (x > -20 && x < 21) {
    const u = (x + 20) / 41;
    const w = u < 0.4 ? lerp(3, 3.8, u / 0.4) : lerp(3.8, 0.9, Math.pow((u - 0.4) / 0.6, 1.4));
    const top = (u < 0.45 ? lerp(2.8, 3.4, u / 0.45) : lerp(3.4, 0.8, (u - 0.45) / 0.55)) - ay * 0.55;
    const bot = -(u < 0.5 ? 2.4 : lerp(2.4, 0.7, (u - 0.5) / 0.5)) + ay * 0.3;
    const slot = x > 11 && ay < 0.9 && z > bot + 0.6;
    if (ay <= w && z <= top && z >= bot && !slot) {
      if (x < -18.6) p.take(ay < 2 && z > -1.4 && z < 1.6 ? Mat.Engine : Mat.Dark);
      else if (z > top - 1 && x > -17 && x < -14.5 && ay < 2) p.take(Mat.Dark);
      else if (z > top - 1 && x > 3 && x < 8 && ay < 1.6) p.take(Mat.Glass);
      else p.take(z < bot + 0.9 ? Mat.Dark : Mat.Hull);
    }
  }
  if (x > -11 && x < -3 && ay < 2.2 && z >= 2 && z <= 5 - (x > -5 ? (x + 5) * 0.8 : 0)) p.take(x > -6.5 && z > 3.4 ? Mat.Glass : Mat.Hull);
  if (ay >= 2.5 && ay <= 11.5) {
    const lead = 1 - (ay - 2.5) * 1.15, trail = -10 - (ay - 2.5) * 0.55;
    if (x <= lead && x >= trail && z >= -0.6 && z <= 0.6) p.take(x > lead - 1.3 && z > -0.2 ? Mat.Accent : z < -0.2 ? Mat.Dark : Mat.Hull);
    if (ay > 10.6 && x <= lead && x >= lead - 1.5 && z > 0) p.take(Mat.Light);
  }
  const ny = ay - 6.5;
  if (x > -19 && x < -2) {
    const rr = (ny * ny) / (1.9 * 1.9) + ((z + 1) * (z + 1)) / (1.8 * 1.8);
    if (rr <= 1) {
      if (x < -17.6 || (x < -16.6 && z > -0.5)) p.take(Mat.Engine);
      else p.take(x > -3.5 ? Mat.Dark : Mat.Hull);
    }
  }
  return p.get();
};

// ---------------------------------------------------------------- Wisp: interceptor
const wisp: Shape = (x, y, z) => {
  const ay = Math.abs(y), p = picker();
  if (x > -13 && x < 15) {
    const u = (x + 13) / 28;
    const w = lerp(2.2, 0.5, Math.pow(u, 1.2));
    const top = lerp(1.9, 0.5, u) - ay * 0.6, bot = -lerp(1.4, 0.4, u);
    if (ay <= w && z <= top && z >= bot) {
      if (x < -11.6) p.take(ay < 1.5 ? Mat.Engine : Mat.Dark);
      else if (z > top - 0.9 && x > 2 && x < 7 && ay < 1) p.take(Mat.Glass);
      else p.take(z < bot + 0.7 ? Mat.Dark : Mat.Hull);
    }
  }
  // Delta wing.
  if (ay >= 1 && ay <= 6.6) {
    const lead = 6 - (ay - 1) * 1.7;
    if (x <= lead && x >= -11 && Math.abs(z) <= 0.45) p.take(x > lead - 1.4 ? Mat.Accent : Mat.Hull);
  }
  // Twin booms with tail fins.
  const by = ay - 4.6;
  if (x > -12.5 && x < 4) {
    if ((by * by) / 1.2 + (z * z) / 0.9 <= 1) p.take(x < -11.4 ? Mat.Engine : x > 2.6 ? Mat.Light : Mat.Hull);
    if (Math.abs(by) < 0.5 && x < -8 && z > 0 && z < 2.6 - (x + 12) * 0.5) p.take(Mat.Dark);
  }
  return p.get();
};

// ---------------------------------------------------------------- Bastion: heavy gun platform
const bastion: Shape = (x, y, z) => {
  const ay = Math.abs(y), p = picker();
  // Lower deck: broad slab, tapering prow.
  if (x > -27 && x < 29) {
    const w = x < 12 ? 9 : lerp(9, 2.5, (x - 12) / 17);
    if (ay <= w && z >= -3 && z <= 1 - Math.max(0, ay - w + 1.5)) {
      if (x < -25.6) p.take(Mat.Dark);
      else if (z > 0 && Math.floor(x + 100) % 5 === 0) p.take(Mat.Dark);
      else if (ay > w - 0.9 && x > -4 && x < 0) p.take(Mat.Accent);
      else p.take(z < -2 ? Mat.Dark : Mat.Hull);
    }
  }
  // Upper deck and command tower.
  if (x > -24 && x < 12 && ay <= 6 && z > 1 && z <= 3.5) p.take(ay > 5.2 ? Mat.Dark : Mat.Hull);
  if (x > -20 && x < -8 && ay <= 3 && z > 3.5 && z <= 7) p.take(x > -10.5 && z > 5 && z < 6.2 ? Mat.Glass : Mat.Hull);
  // Side sponsons.
  if (ay >= 9 && ay <= 14 - Math.max(0, x - 2) * 0.8 && x > -22 && x < 10 && z >= -2.5 && z <= 1.5) {
    p.take(x > 3 && x < 5 ? Mat.Accent : z > 0.8 ? Mat.Hull : Mat.Dark);
  }
  // Turret hardpoints: low domes on the decks.
  for (const [tx, ty, tz] of [[6, 3.5, 3.5], [-2, 3.5, 3.5], [-6, 11.5, 1.5], [-15, 11.5, 1.5]] as Vec[]) {
    const dx = x - tx, dy = ay - ty, dz = z - tz;
    if (dz >= 0 && dx * dx + dy * dy + dz * dz * 2.2 <= 2.4 * 2.4) p.take(dz > 1 ? Mat.Hull : Mat.Dark);
    if (Math.abs(dy) < 0.4 && dx > 0 && dx < 4 && dz > 0.6 && dz < 1.4) p.take(Mat.Hull); // barrel
  }
  // Four engine nozzles.
  for (const ey of [3, 11]) if (x < -25 && x > -28 && ((ay - ey) ** 2) / 4 + (z + 1) ** 2 / 3 <= 1) p.take(Mat.Engine);
  return p.get();
};

// ---------------------------------------------------------------- Mule: hauler
const mule: Shape = (x, y, z) => {
  const ay = Math.abs(y), p = picker();
  if (x > -20 && x < 16 && ay <= 1.6 && z >= -1 && z <= 1.4) p.take(Mat.Dark); // spine
  if (x >= 14 && x < 24) {
    const t = (x - 14) / 10;
    if (ay <= lerp(4, 2, t) && z >= -2 && z <= lerp(3, 1, t)) p.take(z > lerp(3, 1, t) - 1 && x > 17 && x < 21 ? Mat.Glass : Mat.Hull);
  }
  // Container pods in three pairs; the middle pair carries faction livery.
  [-14, -4, 6].forEach((cx, i) => {
    if (Math.abs(x - cx) <= 4 && ay >= 2 && ay <= 8 && z >= -2.5 && z <= 2.5) {
      if (Math.floor(x + 100) % 2 === 0 && z > 2) p.take(Mat.Dark);
      else p.take(i === 1 && z > 1.6 ? Mat.Accent : Mat.Hull);
    }
  });
  if (x > -24 && x <= -19 && ay <= 3.5 && z >= -2 && z <= 2) p.take(x < -23 && ay > 0.8 && ay < 3 && Math.abs(z) < 1.3 ? Mat.Engine : Mat.Hull);
  if (x > 22 && x < 23.5 && ay < 0.6 && z > 0.4 && z < 1.4) p.take(Mat.Light);
  return p.get();
};

interface ShapeSpec { shape: Shape; size: Vec; engines: Vec[]; scale: number }

export const SHAPES = {
  wisp: { shape: wisp, size: [32, 16, 10], engines: [[-13, 0, 0], [-12.5, -4.6, 0], [-12.5, 4.6, 0]], scale: 1.1 },
  lancer: { shape: lancer, size: [46, 26, 12], engines: [[-20, 0, 0], [-18.5, -6.5, -1], [-18.5, 6.5, -1]], scale: 1.3 },
  bastion: { shape: bastion, size: [60, 32, 18], engines: [[-27.5, -3, -1], [-27.5, 3, -1], [-27.5, -11, -1], [-27.5, 11, -1]], scale: 1.15 },
  mule: { shape: mule, size: [52, 20, 12], engines: [[-24, -2, 0], [-24, 2, 0]], scale: 1.2 },
} satisfies Record<string, ShapeSpec>;
export type ShapeId = keyof typeof SHAPES;

const cache = new Map<string, VoxelModel>();
/** Sampling the shape at finer resolution makes a hull bigger *and* more detailed. */
export function shipModel(id: ShapeId, stage = 0) {
  const key = `${id}:${stage}`;
  let m = cache.get(key);
  if (!m) {
    if (stage) {
      const base = shipModel(id);
      m = damageModel(base, shipHits(id, stage), 1.2 + base.sz * 0.08);
    } else {
      const { shape, size, engines, scale: s } = SHAPES[id] as ShapeSpec;
      m = buildModel(
        Math.ceil(size[0] * s), Math.ceil(size[1] * s), Math.ceil(size[2] * s),
        (x, y, z) => shape(x / s, y / s, z / s),
        engines.map(([x, y, z]) => [x * s, y * s, z * s] as Vec),
      );
    }
    cache.set(key, m);
  }
  return m;
}

/** Damage stages 0 (pristine) to 3 (critical), and how many craters each shows. */
export const DAMAGE_HITS = [0, 1, 2, 4];
const hits = new Map<ShapeId, Vec[]>();
/** The crater centres open at a damage stage; the same each time, so wounds only ever add up. */
export function shipHits(id: ShapeId, stage: number): Vec[] {
  let h = hits.get(id);
  if (!h) hits.set(id, (h = pickHits(shipModel(id), DAMAGE_HITS[3], id.length * 7919 + id.charCodeAt(0))));
  return h.slice(0, DAMAGE_HITS[stage]);
}
