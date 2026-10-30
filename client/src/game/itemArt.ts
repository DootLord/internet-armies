// Cargo items as tiny voxel models, ray-cast by the same renderer as ships: lit
// from the same sun, outlined the same way, with glowing parts on the emissive
// layer. In the hold they sit at a three-quarter angle and sway under the cursor.
// Model space as in ships/shapes.ts: x along the item's footprint width, y along
// its height, z up; one unit = one art px (a cargo cell is 16 art px).
import { ItemKind, ITEMS } from './ships/cargo';
import { buildModel, Mat, renderFrame, VoxelModel } from './ships/voxel';
import { accentRamp, hex } from './palette';
import { hash2 } from './rng';

type Shape = (x: number, y: number, z: number) => Mat;
interface ItemSpec { size: [number, number, number]; color: string; shape: Shape }

const r = Math.round;

const SPECS: Record<ItemKind, ItemSpec> = {
  ore: {
    // Three fused lumps of regolith with hot ferrite veins running through them.
    size: [20, 16, 12],
    color: '#ffa245',
    shape: (x, y, z) => {
      const lumps: [number, number, number, number][] = [[-3.5, -1.5, -1, 6], [4, 2.5, -1.5, 5.5], [0.5, -0.5, 2.5, 5]];
      const rough = 0.85 + 0.3 * hash2(r(x * 2), r(y * 2), r(z));
      if (!lumps.some(([a, b, c, rad]) => (x - a) ** 2 + (y - b) ** 2 + ((z - c) * 1.3) ** 2 <= rad * rad * rough)) return Mat.Empty;
      const v = Math.sin(x * 0.9 + y * 0.5) * Math.sin(y * 0.8 - z * 1.1);
      return v > 0.72 ? Mat.Engine : v > 0.5 ? Mat.Accent : Mat.Rock;
    },
  },
  shard: {
    // A leaning hexagonal crystal with a bright tip.
    size: [8, 8, 12],
    color: '#59f2ff',
    shape: (x, y, z) => {
      const h = z + 6, cx = x - (h - 6) * 0.15;
      const rad = h < 8 ? 2.8 : (2.8 * (12 - h)) / 4;
      if (h < 0 || Math.max(Math.abs(cx), Math.abs(y) * 0.87 + Math.abs(cx) * 0.5) > rad) return Mat.Empty;
      return h > 10.5 ? Mat.Light : Mat.Glass;
    },
  },
  scrap: {
    // A buckled, riveted plate with rust blooms and a torn end.
    size: [26, 12, 6],
    color: '#a8460f',
    shape: (x, y, z) => {
      if (Math.abs(x) > 12 || Math.abs(y) > 5) return Mat.Empty;
      if (x > 9 && hash2(r(x), r(y), 5) < 0.45) return Mat.Empty;
      const bend = Math.sin(x * 0.3) * 1.2 + y * 0.15;
      if (Math.abs(z - bend) > 0.9) return Mat.Empty;
      if (z < bend - 0.3) return Mat.Dark;
      if (Math.abs(y) > 3.4 && r(x) % 5 === 0) return Mat.Light;
      return hash2(r(x / 2), r(y / 2), 3) > 0.68 ? Mat.Accent : Mat.Hull;
    },
  },
  fuelcell: {
    // A canister lying on its side: capped ends and a glowing fuel window.
    size: [10, 22, 10],
    color: '#59f2ff',
    shape: (x, y, z) => {
      if (Math.hypot(x, z) > 4.2 || Math.abs(y) > 10) return Mat.Empty;
      if (Math.abs(y) > 8.5) return Math.abs(y) > 9.5 ? Mat.Dark : Mat.Hull;
      if (Math.abs(y) < 5 && z > -1) return Mat.Glass;
      return Math.abs(y) > 6.8 && Math.abs(y) < 7.6 ? Mat.Accent : Mat.Hull;
    },
  },
  relic: {
    // A dark alien slab with a carved glowing ring and a bright core.
    size: [36, 24, 10],
    color: '#c46bff',
    shape: (x, y, z) => {
      const q = (x / 17) ** 2 + (y / 11) ** 2;
      if (q > 1) return Mat.Empty;
      const top = 3.5 * (1 - q) + 0.5;
      if (z > top || z < -3) return Mat.Empty;
      const ring = Math.hypot(x / 9, y / 6);
      if (z > top - 1.2) {
        if (Math.abs(ring - 1) < 0.13) return Mat.Engine;
        if (ring < 0.32) return Mat.Light;
        if ((r(x) + r(y)) % 6 === 0 && q < 0.75) return Mat.Accent;
      }
      return Mat.Dark;
    },
  },
};

const models = new Map<ItemKind, VoxelModel>();
function model(kind: ItemKind) {
  let m = models.get(kind);
  if (!m) {
    const { size, shape } = SPECS[kind];
    models.set(kind, (m = buildModel(size[0], size[1], size[2], shape, [])));
  }
  return m;
}

/** Sprite edge in cargo cells: the footprint's longer side, plus a little headroom for the sway. */
export const itemSpan = (kind: ItemKind) => Math.max(ITEMS[kind].w, ITEMS[kind].h) + 0.5;

/** Resting three-quarter angle, and how far (and in how many steps) an item sways when hovered. */
const BASE_YAW = 0.35, SWAY = 0.3, STEPS = 6;

const poses = new Map<string, string>();
/**
 * An item at rest (`a` = 0) or swayed toward -1..1, as a data URL. Rotated items
 * (`rot`) turn a quarter in 3D too, not just in the grid. Frames are cached.
 */
export function itemPose(kind: ItemKind, rot: boolean, a: number): string {
  const i = Math.round(Math.max(-1, Math.min(1, a)) * STEPS), key = `${kind}|${rot}|${i}`;
  let url = poses.get(key);
  if (!url) {
    const S = Math.round(itemSpan(kind) * 16);
    const f = renderFrame(model(kind), BASE_YAW + (rot ? Math.PI / 2 : 0) + (i / STEPS) * SWAY, 0, accentRamp(hex(SPECS[kind].color)), S);
    const cv = document.createElement('canvas');
    cv.width = cv.height = S;
    const g = cv.getContext('2d')!;
    g.drawImage(f.color, 0, 0);
    g.globalCompositeOperation = 'lighter';
    g.drawImage(f.emit, 0, 0);
    poses.set(key, (url = cv.toDataURL()));
  }
  return url;
}
