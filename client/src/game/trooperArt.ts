// Assault mechs: upright humanoid war machines, voxel models ray-cast by the
// same renderer as ships so they share the sun, outline and bloom. The shape
// is designed in "design units" and sampled K voxels per unit: the finer grid
// is what gives the armour smooth, ship-like shading. Five poses: standing
// (also firing) and a four-step walk with the free arm swinging.
// Model space as in ships/shapes.ts: x forward, y to the side (+y right), z up.
import { FACTIONS } from './defs';
import { buildModel, Mat, PITCH_COS, ShipSprites, VoxelModel, YAW_STEPS } from './ships/voxel';

/** Voxels per design unit. */
const K = 1.7;
const DX = 17, DY = 11, DZ = 22;
/** Height of the beam rifle in design units. */
const RIFLE_H = 11.4;
/** Screen px from the sprite's centre down to the mech's feet. */
export const TROOPER_LIFT = Math.round((Math.round(DZ * K) / 2) * PITCH_COS);
/** Screen px from the feet up to the rifle, for shots and hit tests. */
export const TROOPER_CHEST = Math.round(RIFLE_H * K * PITCH_COS);
/** Half the mech's on-screen width, and its height, for hit tests and overlays. */
export const TROOPER_HALF_W = Math.round(4.5 * K);
export const TROOPER_HEIGHT = Math.round(DZ * K * PITCH_COS);
/** Facings rendered. */
const DIRS = 32;
/** The rifle's muzzle in model space (voxels), for the flash. */
export const MUZZLE: [number, number, number] = [8 * K, 3.1 * K, (RIFLE_H + 0.1 - DZ / 2) * K];

type V = [number, number, number];
/** Distance from p to the segment a-b: limbs are capsules. */
function seg(p: V, a: V, b: V) {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const dd = d[0] ** 2 + d[1] ** 2 + d[2] ** 2, t = dd ? Math.max(0, Math.min(1, (w[0] * d[0] + w[1] * d[1] + w[2] * d[2]) / dd)) : 0;
  return Math.hypot(w[0] - d[0] * t, w[1] - d[1] * t, w[2] - d[2] * t);
}
const box = (v: number, lo: number, hi: number) => v >= lo && v < hi;

/**
 * `stride` swings one leg forward and the other back (-1..1); `lift` raises
 * one foot off the ground (side -1 left / 1 right, 0 for none) as it passes.
 * Colours: Hull is the white armour, Dark the inner frame, Accent the faction
 * trim, Engine the glowing vents and thrusters, Light the eyes.
 */
function mechShape(stride: number, lift: number) {
  // The body dips at full stride and rises as a foot passes under it.
  const bob = lift ? 0.3 : Math.abs(stride) * -0.25;
  return (x: number, y: number, z: number): Mat => {
    const h = z + DZ / 2, p: V = [x, y, h], ay = Math.abs(y), hb = h - bob, pb: V = [x, y, hb];

    // ---- head: helmet, faceplate, twin eyes, V-fin crest
    for (const s of [-1, 1]) if (seg(pb, [0.95, 0, 19.5], [0.5, s * 1.9, 21.2]) < 0.28) return Mat.Accent; // V-fin
    if (seg(pb, [0.9, 0, 19.3], [1.15, 0, 19.7]) < 0.35) return Mat.Engine; // crest jewel
    if (box(hb, 17.6, 20.3) && Math.abs(x - 0.1) < 1.05 && ay < 0.95 - Math.max(0, hb - 19.6) * 0.6) {
      if (x > 0.75 && box(hb, 18.55, 19.05) && box(ay, 0.15, 0.8)) return Mat.Light; // eyes
      if (x > 0.7 && hb < 18.5) return ay < 0.25 ? Mat.Accent : Mat.Dark; // faceplate and chin
      return Mat.Hull;
    }
    if (box(hb, 16.8, 17.7) && ay < 0.6 && Math.abs(x) < 0.6) return Mat.Dark; // neck

    // ---- torso: broad chest with vents and a cockpit hatch, ribbed abdomen, skirt armour
    const chestW = 2 + Math.min(1, Math.max(0, hb - 13)) * 0.7;
    if (box(hb, 13, 17) && ay < chestW && x > -1.5 && x < 1.5 - Math.max(0, hb - 16) * 0.8) {
      if (x > 1.05 && box(hb, 15, 16.5) && box(ay, 0.55, 2)) return Math.round(hb * 3) % 2 ? Mat.Engine : Mat.Dark; // chest vents
      if (ay < 0.5 && x > 1 && box(hb, 13.3, 14.9)) return Mat.Hull; // cockpit hatch
      if (Math.abs(ay - 0.5) < 0.12 || Math.abs(hb - 14.95) < 0.12) return Mat.Dark; // panel lines
      return hb > 14.9 ? Mat.Accent : Mat.Hull;
    }
    if (box(hb, 11.6, 13) && ay < 1.5 && Math.abs(x) < 1.1) return Math.round(hb * 4) % 2 ? Mat.Dark : Mat.Hull; // abdomen
    if (box(hb, 10, 11.8) && ay < 2 && Math.abs(x) < 1.3) return Mat.Dark; // waist
    if (x > 1 && x < 1.7 && box(ay, 0.25, 1.8) && box(hb, 9.2 + ay * 0.3, 11.8)) return ay < 0.5 ? Mat.Hull : Mat.Accent; // front skirt
    if (box(ay, 2, 2.6) && Math.abs(x) < 1.1 && box(hb, 9.4, 11.8)) return Mat.Hull; // side skirts
    if (x < -1.2 && x > -1.8 && ay < 1.6 && box(hb, 9.6, 11.6)) return Mat.Hull; // rear skirt

    // ---- backpack: thruster block, two nozzles, two beam-sword hilts
    if (box(x, -2.7, -1.5) && ay < 1.6 && box(hb, 13, 16.6)) return x < -2.4 && box(ay, 0.4, 1.2) && hb < 14 ? Mat.Engine : Mat.Hull;
    for (const s of [-1, 1]) {
      if (seg(pb, [-2.3, s * 0.9, 13], [-2.7, s * 1, 11.8]) < 0.5) return hb < 12.1 ? Mat.Engine : Mat.Dark;
      if (seg(pb, [-2.2, s * 1.2, 16.4], [-2.6, s * 1.5, 18]) < 0.28) return Mat.Hull;
    }

    // ---- shoulders: big faction pauldrons trimmed in white
    for (const s of [-1, 1])
      if (Math.abs(y - s * 3.3) < 1.15 && Math.abs(x) < 1.5 && box(hb, 14.2, 17)) return hb > 16.5 || Math.abs(x) > 1.2 ? Mat.Hull : Mat.Accent;

    // ---- right arm: forearm held level, hand on a beam rifle
    if (y > 0) {
      if (seg(pb, [0, 3.3, 14.4], [-0.2, 3.3, 12.2]) < 0.75) return Mat.Dark; // upper arm
      if (seg(pb, [-0.2, 3.3, 12.2], [1.6, 3.2, RIFLE_H + 0.2]) < 0.85) return x > -0.2 && x < 0.4 ? Mat.Accent : Mat.Hull; // forearm, cuff
      if (seg(pb, [0.2, 3.1, RIFLE_H], [3.4, 3.1, RIFLE_H]) < 0.55) return Mat.Dark; // rifle body
      if (seg(pb, [1.4, 3.1, RIFLE_H + 0.6], [2.6, 3.1, RIFLE_H + 0.6]) < 0.28) return Mat.Hull; // scope
      if (seg(pb, [3.4, 3.1, RIFLE_H + 0.1], [8, 3.1, RIFLE_H + 0.1]) < 0.3) return x > 7.4 ? Mat.Engine : Mat.Hull; // barrel
      if (seg(pb, [2, 3.1, RIFLE_H - 0.3], [2.3, 3.1, RIFLE_H - 1.3]) < 0.3) return Mat.Dark; // magazine
    }
    // ---- left arm: swings opposite the left leg, carrying a tall shield on the forearm
    const swing = stride * 0.9, elbow: V = [swing * 0.6, -3.3, 12], hand: V = [swing + 0.6, -3.2, 10.4];
    if (y < 0) {
      if (seg(pb, [0, -3.3, 14.4], elbow) < 0.75) return Mat.Dark;
      if (seg(pb, elbow, hand) < 0.85) return Mat.Hull;
      if (seg(pb, hand, hand) < 0.6) return Mat.Dark; // fist
      // Shield: a tall plate on the outside of the forearm, pointed at the bottom.
      const sx = x - (elbow[0] + hand[0]) / 2, top = 14.2, bot = 7.6 + Math.abs(sx) * 1.2;
      if (box(-y, 4.15, 4.75) && Math.abs(sx) < 1.6 && box(hb, bot, top)) {
        if (Math.abs(sx) > 1.25 || hb > top - 0.4 || hb < bot + 0.4) return Mat.Hull;
        return Math.abs(sx) < 0.2 && box(hb, 10, 13) ? Mat.Light : Mat.Accent;
      }
    }

    // ---- legs: hip -> knee (bent forward) -> ankle, armoured shins, big feet
    for (const side of [-1, 1]) {
      const fx = stride * side * 2.1, up = lift === side ? 1.5 : 0, ly = side * 1.3;
      const hip: V = [0, side * 1.25, 10.3 + bob], ankle: V = [fx - up * 0.5, ly, 1.5 + up], knee: V = [(hip[0] + ankle[0]) / 2 + 0.7 + up * 0.8, ly, 5.9 + up * 0.6];
      if (seg(p, hip, knee) < 1.1) return Mat.Dark; // thigh frame
      if (seg(p, [hip[0] + 0.15, ly, hip[2] - 1], [knee[0] + 0.15, ly, knee[2] + 0.6]) < 1.2 && x > (hip[0] + knee[0]) / 2 - 0.2) return Mat.Hull; // thigh armour
      if (seg(p, knee, knee) < 0.95) return x > knee[0] + 0.3 ? Mat.Accent : Mat.Hull; // kneecap
      const shin = seg(p, knee, ankle);
      if (shin < 1.25) return shin > 1 && x < (knee[0] + ankle[0]) / 2 ? Mat.Dark : Mat.Hull;
      const fh = h - up;
      if (fh >= 0 && fh < 1.5 && Math.abs(y - ly) < 1.05 && box(x - ankle[0], -1.3, 2.6)) {
        if (fh < 0.35) return Mat.Dark; // sole
        return x - ankle[0] > 1.9 ? Mat.Accent : Mat.Hull; // toe cap
      }
    }
    return Mat.Empty;
  };
}

function build(stride: number, lift: number): VoxelModel {
  const f = mechShape(stride, lift);
  return buildModel(Math.round(DX * K), Math.round(DY * K), Math.round(DZ * K), (x, y, z) => f(x / K, y / K, z / K), []);
}

/** Pose 0 stands or fires; 1-4 walk: right foot forward, passing, left foot forward, passing. */
const POSES: [number, number][] = [[0, 0], [1, 0], [0, -1], [-1, 0], [0, 1]];
export const WALK = [1, 2, 3, 4];
const models: VoxelModel[] = [];
const sprites = new Map<number, ShipSprites>();

export function mechModel(pose: number) {
  return (models[pose] ??= build(...POSES[pose]));
}

export function trooperFrame(owner: number, pose: number, yaw: number) {
  const key = owner * POSES.length + pose;
  let s = sprites.get(key);
  if (!s) sprites.set(key, (s = new ShipSprites(mechModel(pose), FACTIONS[owner].rgb)));
  const step = YAW_STEPS / DIRS, i = ((Math.round((yaw / (Math.PI * 2)) * DIRS) % DIRS) + DIRS) % DIRS;
  return { frame: s.frame(i * step, 0), half: s.size / 2, yaw: (i / DIRS) * Math.PI * 2 };
}

/** Render a faction's mech frames ahead of need, a slice per call, so a new facing never stalls a frame. */
export function warmMechs(owner: number, budgetMs: number) {
  const t0 = performance.now();
  for (let pose = 0; pose < POSES.length; pose++)
    for (let i = 0; i < DIRS; i++) {
      trooperFrame(owner, pose, (i / DIRS) * Math.PI * 2);
      if (performance.now() - t0 > budgetMs) return;
    }
}
